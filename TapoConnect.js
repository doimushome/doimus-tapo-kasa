const axios = require("axios");
const { createHash, randomBytes } = require("crypto");

function concatBuf(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sha1(data) {
  const h = createHash("sha1");
  h.update(typeof data === "string" ? data : data, typeof data === "string" ? "utf8" : undefined);
  return h.digest();
}

function sha256(data) {
  const h = createHash("sha256");
  h.update(data);
  return h.digest();
}

function encode(str) {
  return Buffer.from(str, "utf8");
}

function base64Encode(buf) {
  return buf.toString("base64");
}

function compare(b1, b2) {
  if (b1.length !== b2.length) return false;
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] !== b2[i]) return false;
  }
  return true;
}

function deriveKey(localSeed, remoteSeed, userHash) {
  return sha256(concatBuf(encode("lsk"), localSeed, remoteSeed, userHash)).subarray(0, 16);
}

function deriveIv(localSeed, remoteSeed, userHash) {
  return sha256(concatBuf(encode("iv"), localSeed, remoteSeed, userHash));
}

function deriveSig(localSeed, remoteSeed, userHash) {
  return sha256(concatBuf(encode("ldk"), localSeed, remoteSeed, userHash)).subarray(0, 28);
}

function deriveSeqFromIv(iv) {
  return iv.subarray(iv.length - 4);
}

function incrementSeq(seq) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(seq.readInt32BE() + 1);
  return buffer;
}

function pkcs7Pad(text, blockSize) {
  const padSize = blockSize - (text.length % blockSize);
  return text + String.fromCharCode(padSize).repeat(padSize);
}

function pkcs7Unpad(text) {
  const paddingLength = text.charCodeAt(text.length - 1);
  if (paddingLength > 16 || paddingLength > text.length) {
    throw new Error("Invalid padding");
  }
  for (let i = text.length - paddingLength; i < text.length; i++) {
    if (text.charCodeAt(i) !== paddingLength) {
      throw new Error("Invalid padding");
    }
  }
  return text.slice(0, text.length - paddingLength);
}

function aesEncrypt(plaintext, key, iv) {
  const crypto = require("crypto");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  let encrypted = cipher.update(pkcs7Pad(plaintext, 16), "utf8", "hex");
  encrypted += cipher.final("hex");
  return Buffer.from(encrypted, "hex");
}

function aesDecrypt(encryptedHex, key, iv) {
  const crypto = require("crypto");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return pkcs7Unpad(decrypted);
}

function encryptAndSignKlap(data, key, iv, sig, seq) {
  const keySeq = Buffer.concat([key, seq]);
  const ivSeq = Buffer.concat([iv, seq]);
  const encrypted = aesEncrypt(JSON.stringify(data), keySeq.subarray(0, 16), ivSeq.subarray(0, 16));
  const sigData = Buffer.concat([sig, seq, Buffer.from(JSON.stringify(data))]);
  const signature = sha256(sigData).subarray(0, 16);
  return Buffer.concat([encrypted, signature]);
}

function decryptKlap(data, key, iv, seq) {
  const encryptedLength = data.length - 16;
  const encrypted = data.subarray(0, encryptedLength);
  const signature = data.subarray(encryptedLength);
  const keySeq = Buffer.concat([key, seq]);
  const ivSeq = Buffer.concat([iv, seq]);
  const decrypted = aesDecrypt(encrypted.toString("hex"), keySeq.subarray(0, 16), ivSeq.subarray(0, 16));
  return JSON.parse(decrypted);
}

function generateKeyPair() {
  const crypto = require("crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function extractPublicKey(pem) {
  const lines = pem.split("\n");
  const keyData = lines.filter((l) => !l.startsWith("-----") && l.trim()).join("");
  return Buffer.from(keyData, "base64");
}

function checkError(responseData) {
  const errorCode = responseData?.error_code;
  if (errorCode) {
    switch (errorCode) {
      case 0:
        return;
      case -1010:
        throw new Error("Invalid public key length");
      case -1012:
        throw new Error("Invalid terminal UUID");
      case -1501:
        throw new Error("Invalid request or credentials");
      case -1002:
        throw new Error("Incorrect request");
      case -1003:
        throw new Error("JSON format error");
      case -20601:
        throw new Error("Incorrect email or password");
      case -20675:
        throw new Error("Cloud token expired or invalid");
      case 9999:
        throw new Error("Device token expired or invalid");
      default:
        throw new Error(`Unexpected Error Code: ${errorCode} (${responseData?.msg})`);
    }
  }
}

class TapoConnect {
  constructor(log, email, password, deviceIp) {
    this.log = log;
    this.email = email;
    this.password = password;
    this.deviceIp = deviceIp;
    this.sessionCookie = undefined;
    this.deviceKey = {};
    this.seq = undefined;
    this.sig = undefined;
    this.token = undefined;
    this.usePassThroughProtocol = true;
    this.CONNECT_TIMEOUT = 20000;
  }

  async handshakePassThrough() {
    const { publicKey, privateKey } = generateKeyPair();
    const publicKeyBuf = extractPublicKey(publicKey);

    const handshakeRequest = {
      method: "handshake",
      params: { key: publicKeyBuf.toString("base64") },
    };

    const response = await axios({
      method: "post",
      url: `http://${this.deviceIp}/app`,
      data: handshakeRequest,
      timeout: this.CONNECT_TIMEOUT,
    });

    checkError(response.data);

    if (response.headers?.["set-cookie"]) {
      const setCookieHeader = response.headers["set-cookie"][0];
      this.sessionCookie = setCookieHeader.substring(0, setCookieHeader.indexOf(";"));
    }

    const deviceKeyBuf = Buffer.from(response.data.result.key, "base64");
    this.deviceKey.key = deviceKeyBuf.subarray(0, 16);
    this.deviceKey.iv = deviceKeyBuf.subarray(16, 32);
  }

  async loginPassThrough() {
    const loginDeviceRequest = {
      method: "login_device",
      params: {
        username: base64Encode(sha1(this.email)),
        password: base64Encode(this.password),
      },
      requestTimeMils: 0,
    };

    const loginDeviceResponse = await this.sendPassthrough(loginDeviceRequest);
    this.token = loginDeviceResponse.token;
  }

  async sendPassthrough(deviceRequest) {
    const encryptedRequest = aesEncrypt(JSON.stringify(deviceRequest), this.deviceKey.key, this.deviceKey.iv);
    const securePassthroughRequest = {
      method: "securePassthrough",
      params: { request: encryptedRequest.toString("base64") },
    };

    const response = await axios({
      method: "post",
      url: `http://${this.deviceIp}/app?token=${this.token}`,
      data: securePassthroughRequest,
      headers: { Cookie: this.sessionCookie },
      timeout: this.CONNECT_TIMEOUT,
    });

    checkError(response.data);

    const decryptedResponse = aesDecrypt(response.data.result.response, this.deviceKey.key, this.deviceKey.iv);
    checkError(decryptedResponse);

    return decryptedResponse.result;
  }

  async handshakeAndLoginKlap() {
    const localSeed = randomBytes(16);

    const response = await axios
      .post(`http://${this.deviceIp}/app/handshake1`, localSeed, {
        responseType: "arraybuffer",
        withCredentials: true,
        timeout: this.CONNECT_TIMEOUT,
      })
      .catch((error) => {
        if (error.response && error.response.status === 404) {
          throw new Error("Klap protocol not supported");
        }
        throw new Error(`handshake1 failed: ${error}`);
      });

    const responseBytes = Buffer.from(response.data);
    const setCookieHeader = response.headers["set-cookie"]?.[0];
    this.sessionCookie = setCookieHeader?.substring(0, setCookieHeader.indexOf(";"));

    const remoteSeed = responseBytes.subarray(0, 16);
    const serverHash = responseBytes.subarray(16);

    const localAuthHash = sha256(concatBuf(sha1(this.email), sha1(this.password)));
    const localSeedAuthHash = sha256(concatBuf(localSeed, remoteSeed, localAuthHash));

    if (!compare(localSeedAuthHash, serverHash)) {
      throw new Error("email or password incorrect");
    }

    const payload = sha256(concatBuf(remoteSeed, localSeed, localAuthHash));
    await axios.post(`http://${this.deviceIp}/app/handshake2`, payload, {
      responseType: "arraybuffer",
      headers: { Cookie: this.sessionCookie },
      timeout: this.CONNECT_TIMEOUT,
    });

    this.deviceKey.key = deriveKey(localSeed, remoteSeed, localAuthHash);
    this.deviceKey.iv = deriveIv(localSeed, remoteSeed, localAuthHash);
    this.sig = deriveSig(localSeed, remoteSeed, localAuthHash);
    this.seq = deriveSeqFromIv(this.deviceKey.iv);
  }

  async sendKlap(deviceRequest) {
    this.seq = incrementSeq(this.seq);

    const encryptedRequest = encryptAndSignKlap(deviceRequest, this.deviceKey.key, this.deviceKey.iv, this.sig, this.seq);

    const response = await axios({
      method: "post",
      url: `http://${this.deviceIp}/app/request`,
      data: encryptedRequest,
      responseType: "arraybuffer",
      timeout: this.CONNECT_TIMEOUT,
      headers: { Cookie: this.sessionCookie },
      params: { seq: this.seq.readInt32BE() },
    });

    const decryptedResponse = decryptKlap(Buffer.from(response.data), this.deviceKey.key, this.deviceKey.iv, this.seq);
    checkError(decryptedResponse);

    return decryptedResponse.result;
  }

  async send(deviceRequest) {
    if (this.usePassThroughProtocol) {
      return this.sendPassthrough(deviceRequest);
    }
    return this.sendKlap(deviceRequest);
  }

  async login() {
    try {
      await this.handshakePassThrough();
      await this.loginPassThrough();
      this.usePassThroughProtocol = true;
    } catch (error) {
      this.usePassThroughProtocol = false;
      this.sessionCookie = undefined;
      this.deviceKey = {};
      this.token = undefined;
    }
    if (!this.usePassThroughProtocol) {
      try {
        await this.handshakeAndLoginKlap();
      } catch (error) {
        throw new Error(`Failed to connect via passthrough (${error.message}) and KLAP fallback also failed`);
      }
    }
  }

  static getControlChild(deviceId, request) {
    return {
      method: "control_child",
      params: {
        device_id: deviceId,
        requestData: {
          method: "multipleRequest",
          params: { requests: [request] },
        },
      },
    };
  }

  async getChildDeviceList(startIndex = 0) {
    const request = {
      method: "get_child_device_list",
      params: { start_index: startIndex },
    };
    return await this.send(request);
  }

  async getChildTriggerLogs(deviceId) {
    const req = TapoConnect.getControlChild(deviceId, {
      method: "get_trigger_logs",
      params: { start_id: 0, page_size: 1 },
    });
    return await this.send(req);
  }

  async setTempOn(targetTemp, on, deviceId) {
    const cmdRequest = TapoConnect.getControlChild(deviceId, {
      method: "set_device_info",
      params: {
        frost_protection_on: !on,
        target_temp: targetTemp,
        temp_unit: "celsius",
      },
    });
    return await this.send(cmdRequest);
  }

  static parseDevices(devices, tapoConnect, log) {
    const deviceList = [];
    for (const device of devices.child_device_list ?? []) {
      if (device.status !== "online") continue;

      let deviceType = null;
      log?.debug(`Found device ${device.device_id} category=${device.category}`);

      switch (device.category) {
        case "subg.trigger.temp-hmdt-sensor":
          deviceType = "temperature_humidity_sensor";
          break;
        case "subg.trv":
          deviceType = "thermostat";
          break;
        case "subg.trigger.contact-sensor":
          deviceType = "contact_sensor";
          break;
        case "subg.trigger.water-leak-sensor":
          deviceType = "leak_sensor";
          break;
        case "subg.trigger.motion-sensor":
          deviceType = "motion_sensor";
          break;
      }

      if (deviceType === null) {
        try {
          const nickname = device.nickname ? Buffer.from(device.nickname, "base64").toString() : "unknown";
          log?.debug(`Skipping unsupported device ${device.device_id} (${nickname}) category=${device.category}`);
        } catch {
          // ignore decode errors
        }
        continue;
      }

      const nickname = device.nickname ? Buffer.from(device.nickname, "base64").toString() : "unknown";

      deviceList.push({
        tapoConnect,
        name: nickname,
        uniqueId: device.device_id,
        model: device.model,
        firmware: device.fw_ver,
        deviceType,
        currentTemp: device.current_temp,
        currentHumidity: device.current_humidity,
        sleep: device.trv_states?.every((state) => state === "shutdown") ?? false,
        targetTemp: device.target_temp,
        tempUnit: device.temp_unit,
        frostProtectionOn: device.frost_protection_on,
        minControlTemp: device.min_control_temp,
        maxControlTemp: device.max_control_temp,
        atLowBattery: device.at_low_battery,
        contactOpen: typeof device.open === "boolean" ? device.open : undefined,
        leakDetected: (() => {
          if (typeof device.water_leak_status === "string") {
            return device.water_leak_status.toLowerCase() === "water_leak";
          }
          if (typeof device.in_alarm === "boolean") {
            return device.in_alarm;
          }
          return undefined;
        })(),
        motionDetected: typeof device.detected === "boolean" ? device.detected : undefined,
      });
    }
    return deviceList;
  }
}

module.exports = { TapoConnect };
