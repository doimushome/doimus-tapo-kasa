const net = require("net");
const crypto = require("crypto");
const EventEmitter = require("events");

// Super-secret key used by legacy firmware when media encryption is disabled
// (Key-Exchange header advertises `username="none"`). Documented in go2rtc.
const SUPER_SECRET_KEY = "TPL075526460603";

function hashPassword(password, method) {
  if (method === "sha256") {
    return crypto
      .createHash("sha256")
      .update(password)
      .digest("hex")
      .toUpperCase();
  }
  return crypto.createHash("md5").update(password).digest("hex").toUpperCase();
}

function md5Hex(...parts) {
  return crypto
    .createHash("md5")
    .update(parts.join(":"))
    .digest("hex");
}

function sha256Hex(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.join(":"))
    .digest("hex");
}

function between(buf, start, end) {
  const s = buf.indexOf(start);
  if (s === -1) return null;
  const e = buf.indexOf(end, s + start.length);
  if (e === -1) return null;
  return buf.substring(s + start.length, e);
}

function aesDecrypt(ciphertext, key, iv) {
  // Node auto-strips PKCS7 padding on final(); ciphertext length is always a
  // multiple of 16 for AES-CBC, so no manual unpadding is needed.
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted;
}

// HKDF-SHA256 extract+expand (RFC 5869), matching the app's BouncyCastle
// HKDFBytesGenerator used for the newer "HKDF" media key scheme.
function hkdf(ikm, salt, info, len) {
  const extract = crypto
    .createHmac("sha256", salt && salt.length ? salt : Buffer.alloc(32))
    .update(ikm)
    .digest();
  const okm = Buffer.alloc(len);
  let t = Buffer.alloc(0);
  let pos = 0;
  let counter = 1;
  while (pos < len) {
    t = crypto
      .createHmac("sha256", extract)
      .update(Buffer.concat([t, info, Buffer.from([counter])]))
      .digest();
    t.copy(okm, pos);
    pos += t.length;
    counter++;
  }
  return okm;
}

// Tapo proprietary media-stream protocol on TCP/8800.
// `POST /stream` with Digest auth, AES-128-CBC-encrypted multipart MPEG-TS
// frames. Reverse-engineered from the official Tapo app (pytapo / go2rtc).
class TapoStreamClient extends EventEmitter {
  constructor(log, options) {
    super();
    this.log = log;
    this.ip = options.ip;
    this.port = options.port || 8800;
    this.username = options.username || "admin";
    this.cloudPassword = options.cloudPassword;
    this.deviceId = options.deviceId || null; // hub child device id
    this.quality = options.quality || "HD"; // HD | VGA
    this.timeout = options.timeout || 10000;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.aesKey = null;
    this.aesIv = null;
    this.hashMethod = "md5";
    this.started = false;
    this.ended = false;
  }

  _log(level, msg) {
    this.log?.(level, `[TapoStream ${this.ip}] ${msg}`);
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.ip);
      this.socket = socket;
      socket.setTimeout(this.timeout);

      const onError = (err) => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        this.emit("error", err);
        reject(err);
      };

      const onConnect = () => {
        this._log("debug", `connected to ${this.ip}:${this.port}`);
        this._sendStreamRequest().catch((err) => {
          onError(err);
        });
      };

      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.started) {
          this._drainStream();
        } else {
          this._processHandshake(resolve, reject, onError).catch((err) => {
            onError(err);
          });
        }
      };

      socket.on("connect", onConnect);
      socket.on("data", onData);
      socket.on("error", onError);
    });
  }

  // Builds and sends the initial `POST /stream` request (unauthorized).
  _buildRequest(headers) {
    let req = "POST /stream HTTP/1.1\r\n";
    if (this.deviceId) {
      req = `POST /stream?deviceId=${encodeURIComponent(this.deviceId)} HTTP/1.1\r\n`;
    }
    for (const [k, v] of Object.entries(headers)) {
      req += `${k}: ${v}\r\n`;
    }
    return req + "\r\n";
  }

  _streamHeaders(authorization) {
    const headers = {
      "Content-Type": "multipart/mixed;boundary=--client-stream-boundary--",
      "User-Agent": "Tapo CameraClient Android",
      Connection: "keep-alive",
      "Content-Length": "0",
      "X-Key-Exchange": "1",
    };
    if (authorization) headers.Authorization = authorization;
    return headers;
  }

  _sendStreamRequest(authorization) {
    return this._write(this._buildRequest(this._streamHeaders(authorization)));
  }

  _write(data) {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Reads buffered HTTP response headers until \r\n\r\n.
  _readHeaders() {
    const idx = this.buffer.indexOf("\r\n\r\n");
    if (idx === -1) return null;
    const headerBlock = this.buffer.subarray(0, idx).toString("latin1");
    this.buffer = this.buffer.subarray(idx + 4);
    return headerBlock;
  }

  // Handshake: 401 → digest auth → 200 with Key-Exchange → AES setup.
  async _processHandshake(resolve, reject, onError) {
    // First response must be the 401 challenge (or possibly an HTTP ERROR blob).
    if (this._handshakeStage === undefined) {
      const headers = this._readHeaders();
      if (!headers) return; // wait for more data

      const statusLine = headers.split("\r\n")[0];
      const statusCode = parseInt(statusLine.split(" ")[1], 10);

      this._log("debug", `stage1 status: ${statusLine}`);

      if (statusCode !== 401) {
        return reject(
          new Error(
            `Unexpected stage1 status ${statusCode}: ${statusLine.slice(0, 120)}`,
          ),
        );
      }

      const auth = between(headers, "WWW-Authenticate:", "\r\n");
      if (!auth) {
        return reject(new Error("Missing WWW-Authenticate header"));
      }

      const realm = between(auth, 'realm="', '"');
      const nonce = between(auth, 'nonce="', '"');
      const qop = between(auth, 'qop="', '"') || "auth";
      const opaque = between(auth, 'opaque="', '"');
      if (!realm || !nonce) {
        return reject(new Error("Missing digest realm/nonce in challenge"));
      }

      // Newer firmware advertises encrypt_type="3" (SHA256) for the password hash.
      this.hashMethod = auth.includes('encrypt_type="3"') ? "sha256" : "md5";
      const hashedPassword = hashPassword(this.cloudPassword, this.hashMethod);

      // Digest may use SHA-256 when the challenge explicitly requests it.
      const digestAlgo = /algorithm="?(SHA-256|sha-256)"?/i.test(auth)
        ? "sha256"
        : "md5";
      const ha = digestAlgo === "sha256" ? sha256Hex : md5Hex;

      const cnonce = crypto.randomBytes(12).toString("hex");
      const nc = "00000001";
      const uri = this.deviceId ? `/stream?deviceId=${encodeURIComponent(this.deviceId)}` : "/stream";

      const ha1 = ha(this.username, realm, hashedPassword);
      const ha2 = ha("POST", uri);
      const response = ha(ha1, nonce, nc, cnonce, qop, ha2);

      let authHeader = `Digest username="${this.username}",realm="${realm}",uri="${uri}",algorithm=${digestAlgo === "sha256" ? "SHA-256" : "MD5"},nonce="${nonce}",nc=${nc},cnonce="${cnonce}",qop=${qop},response="${response}"`;
      if (opaque) authHeader += `,opaque="${opaque}"`;

      this._handshakeStage = 1;
      await this._sendStreamRequest(authHeader);
      return; // wait for the 200 response
    }

    // Stage 2: expect 200 with Key-Exchange header.
    const headers = this._readHeaders();
    if (!headers) return;

    const statusLine = headers.split("\r\n")[0];
    const statusCode = parseInt(statusLine.split(" ")[1], 10);
    this._log("debug", `stage2 status: ${statusLine}`);

    if (statusCode !== 200) {
      return reject(
        new Error(
          `Unexpected stage2 status ${statusCode}: ${statusLine.slice(0, 120)}`,
        ),
      );
    }

    const keyExchange = between(headers, "Key-Exchange:", "\r\n");
    if (!keyExchange) {
      return reject(new Error("Missing Key-Exchange header"));
    }

    const exchangeNonce = between(keyExchange, 'nonce="', '"');
    const exchangeUser = between(keyExchange, 'username="', '"');
    if (!exchangeNonce) {
      return reject(new Error("Missing nonce in Key-Exchange header"));
    }

    // Parse the full Key-Exchange parameter list (some firmwares advertise
    // `algorithm="HKDF"` + `salt`, a newer key scheme than the legacy MD5 one).
    const keParams = {};
    for (const kv of keyExchange.split(" ")) {
      const m = /^([^=\s]+)="?([^"]*)"?$/.exec(kv.trim());
      if (m) keParams[m[1]] = m[2];
    }

    if (keParams.algorithm === "HKDF") {
      // Newer scheme: AES key = HKDF-SHA256(ikm = nonce:password, salt,
      // info = "stream_hkdf_aes_key", 16). IV is per-part (X-Nonce header),
      // NOT a fixed value — see _drainStream.
      this.hkdfMode = true;
      const hkdfPassword =
        exchangeUser === "none"
          ? SUPER_SECRET_KEY
          : hashPassword(this.cloudPassword, this.hashMethod);
      this.aesKey = hkdf(
        Buffer.from(`${exchangeNonce}:${hkdfPassword}`, "utf8"),
        Buffer.from(keParams.salt || "", "utf8"),
        Buffer.from("stream_hkdf_aes_key", "utf8"),
        16,
      );
      this.aesIv = null;
    } else if (exchangeUser === "none") {
      // Media encryption disabled (legacy firmware).
      this.aesKey = crypto
        .createHash("md5")
        .update(`${exchangeNonce}:${SUPER_SECRET_KEY}`)
        .digest();
      this.aesIv = crypto
        .createHash("md5")
        .update(`none:${exchangeNonce}`)
        .digest();
    } else {
      const hashedPassword = hashPassword(this.cloudPassword, this.hashMethod);
      this.aesKey = crypto
        .createHash("md5")
        .update(`${exchangeNonce}:${hashedPassword}`)
        .digest();
      this.aesIv = crypto
        .createHash("md5")
        .update(`${this.username}:${exchangeNonce}`)
        .digest();
    }

    // Send the preview request to begin streaming. Mark started before
    // sending so any data that arrives during the write is routed to the
    // multipart parser, not the handshake.
    this._handshakeStage = 2;
    this.started = true;
    await this._sendPreviewRequest();
    this._drainStream();
    resolve();
  }

  _sendPreviewRequest() {
    const payload = JSON.stringify({
      type: "request",
      seq: 1,
      params: {
        preview: {
          audio: ["default"],
          channels: [0],
          resolutions: [this.quality],
        },
        method: "get",
      },
    });

    const part =
      "----client-stream-boundary--\r\n" +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "\r\n" +
      payload +
      "\r\n";

    return this._write(part);
  }

  // Handles buffered multipart data: strips the device boundary + headers,
  // decrypts video/mp2t parts, and emits TS bytes.
  _drainStream() {
    if (this.ended) return;

    const boundary = "--device-stream-boundary--";
    while (true) {
      const bIdx = this.buffer.indexOf(boundary);
      if (bIdx === -1) return;

      const afterBoundary = this.buffer.subarray(bIdx + boundary.length);
      // Skip CRLF after boundary.
      let off = 0;
      if (afterBoundary[0] === 0x0d && afterBoundary[1] === 0x0a) off = 2;
      else if (afterBoundary[0] === 0x0a) off = 1;

      const headersEnd = afterBoundary.indexOf("\r\n\r\n", off);
      if (headersEnd === -1) return; // wait for full headers

      const headerBlock = afterBoundary.subarray(off, headersEnd).toString("latin1");
      const bodyStart = headersEnd + 4;

      // parse Content-Length
      const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!clMatch) {
        this._log("warn", `part missing Content-Length, skipping`);
        this.buffer = afterBoundary.subarray(bodyStart);
        continue;
      }
      const contentLength = parseInt(clMatch[1], 10);
      const bodyEnd = bodyStart + contentLength;
      if (afterBoundary.length < bodyEnd) return; // wait for full body

      const body = afterBoundary.subarray(bodyStart, bodyEnd);
      this.buffer = afterBoundary.subarray(bodyEnd);

      const contentType = (headerBlock.match(/Content-Type:\s*(.*)/i)?.[1] || "").trim();
      const isEncrypted = /X-If-Encrypt:\s*1/i.test(headerBlock);

      if (contentType === "application/json") {
        this._handleJsonPart(body);
      } else if (contentType === "video/mp2t") {
        let ts;
        if (isEncrypted) {
          let iv = this.aesIv;
          if (this.hkdfMode) {
            // Newer scheme: each part carries its own X-Nonce (hex) used as
            // the AES-CBC IV.
            const xn = /X-Nonce:\s*([0-9a-fA-F]{32})/.exec(headerBlock)?.[1];
            if (!xn) {
              this._log("warn", "HKDF part missing X-Nonce, skipping");
              continue;
            }
            iv = Buffer.from(xn, "hex");
          }
          try {
            ts = aesDecrypt(body, this.aesKey, iv);
          } catch (e) {
            this._log("warn", `AES decrypt failed: ${e.message}`);
            continue;
          }
        } else {
          ts = body;
        }
        this.emit("data", ts);
      } else {
        this._log("debug", `ignoring part of type ${contentType}`);
      }
    }
  }

  _handleJsonPart(body) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      if (json?.type === "response" && json?.error_code && json.error_code !== 0) {
        this._log("warn", `stream error: ${JSON.stringify(json)}`);
      }
    } catch (_) {
      this._log("debug", `unparseable JSON part: ${body.toString("utf8").slice(0, 80)}`);
    }
  }

  close() {
    this.ended = true;
    this.socket?.destroy();
  }
}

module.exports = { TapoStreamClient };
