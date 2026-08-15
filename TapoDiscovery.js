const dgram = require("dgram");
const crypto = require("crypto");

const TDP_PORTS = [20002, 20004];
const TDP_BROADCAST_IP = "255.255.255.255";
const TDP_HEADER_SIZE = 16;
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildQuery() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const payload = Buffer.from(
    JSON.stringify({ params: { rsa_key: publicKey } }),
    "utf8",
  );

  const header = Buffer.alloc(TDP_HEADER_SIZE);
  header.writeUInt8(2, 0); // version
  header.writeUInt8(0, 1); // msg_type
  header.writeUInt16BE(1, 2); // op_code (V2 discovery)
  header.writeUInt16BE(payload.length, 4); // payload len
  header.writeUInt8(17, 6); // flags: BROADCAST(0x10) | REQUEST(0x01)
  header.writeUInt8(0, 7); // padding
  header.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8); // serial
  header.writeUInt32BE(0x5a6b7c8d, 12); // initial crc, replaced below

  const query = Buffer.concat([header, payload]);
  query.writeUInt32BE(crc32(query), 12);
  return query;
}

// TDP (Tapo Device Protocol) broadcast discovery — the same UDP probe the
// official app uses to find cameras on the LAN. Returns devices with `ip`,
// `mac`, `device_id`, `device_model`, `device_name`, `device_type`.
//
// Broadcast only works on hosts that share the LAN broadcast domain (host
// networking on a Pi). Inside containers (e.g. Docker Desktop for Mac) the
// broadcast never leaves the bridge, so `discoverDevices` also accepts a
// `subnet` (e.g. "192.168.1.0/24") to unicast-probe every host instead.
async function discoverDevices(log, timeoutMs = 4000, subnet = null) {
  if (subnet) {
    return sweepDiscover(log, subnet, timeoutMs);
  }
  return broadcastDiscover(log, timeoutMs);
}

function broadcastDiscover(log, timeoutMs) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const devices = new Map();
  const query = buildQuery();

  const finish = () => {
    socket.removeAllListeners("message");
    socket.close();
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish();
      resolve([...devices.values()]);
    }, timeoutMs);

    socket.on("error", (err) => {
      log?.("warn", `TDP discovery socket error: ${err.message}`);
      clearTimeout(timer);
      finish();
      resolve([...devices.values()]);
    });

    socket.on("message", (msg, rinfo) => {
      const d = parseResponse(msg, rinfo, devices, log);
      if (d) devices.set(d.mac, d);
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const port of TDP_PORTS) {
        try {
          socket.send(query, 0, query.length, port, TDP_BROADCAST_IP);
        } catch (e) {
          log?.("warn", `TDP send to ${port} failed: ${e.message}`);
        }
      }
    });
  });
}

// Unicast probe of every host in `subnet` on ports 20002/20004. Used where
// broadcast cannot reach the LAN (Docker/macOS).
function sweepDiscover(log, subnet, timeoutMs) {
  const ips = expandSubnet(subnet);
  if (!ips.length) {
    log?.("warn", `TDP: invalid subnet "${subnet}", falling back to broadcast`);
    return broadcastDiscover(log, timeoutMs);
  }

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const devices = new Map();
  const query = buildQuery();

  const finish = () => {
    socket.removeAllListeners("message");
    socket.close();
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log?.("debug", `TDP sweep of ${ips.length} host(s) done (${devices.size} found)`);
      finish();
      resolve([...devices.values()]);
    }, timeoutMs);

    socket.on("error", (err) => {
      log?.("warn", `TDP sweep socket error: ${err.message}`);
      clearTimeout(timer);
      finish();
      resolve([...devices.values()]);
    });

    socket.on("message", (msg, rinfo) => {
      const d = parseResponse(msg, rinfo, devices, log);
      if (d) devices.set(d.mac, d);
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      let sent = 0;
      const sendOne = (ip, port) => {
        try {
          socket.send(query, 0, query.length, port, ip, () => {
            sent++;
            if (sent >= ips.length * TDP_PORTS.length) {
              log?.("debug", `TDP sweep sent to ${sent} (ip,port) targets`);
            }
          });
        } catch (e) {
          log?.("warn", `TDP sweep send to ${ip}:${port} failed: ${e.message}`);
        }
      };
      for (const ip of ips) {
        for (const port of TDP_PORTS) sendOne(ip, port);
      }
    });
  });
}

function parseResponse(msg, rinfo, devices, log) {
  if (msg.length <= TDP_HEADER_SIZE) return null;
  let json;
  try {
    json = JSON.parse(msg.subarray(TDP_HEADER_SIZE).toString("utf8"));
  } catch (_) {
    return null;
  }
  const result = json?.result;
  if (!result || !result.ip) return null;
  const mac = (result.mac || "").toLowerCase();
  if (!mac || devices.has(mac)) return null;
  const device = {
    ip: result.ip,
    mac,
    deviceId: result.device_id || null,
    deviceType: result.device_type || null,
    deviceModel: result.device_model || null,
    deviceName: result.device_name || result.nickname || null,
    encryptType: result.mgt_encrypt_schm?.encrypt_type || null,
    supportsHttps: result.mgt_encrypt_schm?.is_support_https ?? null,
  };
  log?.("debug", `TDP found ${mac} at ${result.ip} (${result.device_model})`);
  return device;
}

// Expands "192.168.1.0/24" to host IPs (excluding .0 and .255).
function expandSubnet(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    String(cidr || "").trim(),
  );
  if (!m) return [];
  const ip = (m.slice(1, 5).map(Number));
  const prefix = parseInt(m[5], 10);
  if (ip.some((o) => o > 255) || prefix < 8 || prefix > 30) return [];
  const shift = 32 - prefix;
  const start =
    ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) & (0xffffffff << shift);
  const count = 1 << shift;
  const out = [];
  for (let i = 1; i < count - 1; i++) {
    const v = (start + i) >>> 0;
    out.push(`${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`);
  }
  return out;
}

// Best-effort LAN subnet detection from the local route table. Useful on
// hosts where the backend shares the LAN namespace (host networking on a Pi):
// the container's own routes include the LAN subnet, so no config is needed.
// Returns "192.168.1.0/24" or null.
function detectSubnet() {
  try {
    const fs = require("fs");
    const data = fs.readFileSync("/proc/net/route", "utf8");
    const lines = data.trim().split("\n").slice(1);
    for (const line of lines) {
      const [iface, destHex, , , , , , maskHex] = line.split(/\s+/);
      if (!destHex || !maskHex) continue;
      if (/^(lo|docker\d*|br-|veth|virbr)/.test(iface)) continue;
      const dest = parseInt(destHex, 16);
      const mask = parseInt(maskHex, 16);
      if (dest === 0 || mask === 0) continue;
      // Only private LAN ranges (RFC 1918).
      const in10 = (dest & 0xff000000) === 0x0a000000;
      const in172 = (dest & 0xfff00000) === 0xac100000;
      const in192 = (dest & 0xffff0000) === 0xc0a80000;
      if (!in10 && !in172 && !in192) continue;
      // Skip /8 over-broad routes and non-subnet routes.
      let prefix = 0;
      for (let b = 31; b >= 0; b--) {
        if ((mask >>> b) & 1) prefix++;
      }
      if (prefix < 8 || prefix > 30) continue;
      return `${(dest >>> 24) & 0xff}.${(dest >>> 16) & 0xff}.${(dest >>> 8) & 0xff}.0/${prefix}`;
    }
  } catch (_) {
    // Not Linux or no /proc — no auto-detection available.
  }
  return null;
}

module.exports = { discoverDevices, detectSubnet };
