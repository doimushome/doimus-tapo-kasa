#!/usr/bin/env node
// Debug probe for the Tapo camera P2P media protocol (TCP/8800) and TDP
// LAN discovery. Not part of the plugin runtime.
//
// Usage:
//   node scripts/probe.js discover
//   node scripts/probe.js stream <ip> <cloudPassword> [quality] [seconds]
//   node scripts/probe.js stream <ip> <cloudPassword> <deviceId> [quality] [seconds]

const { discoverDevices } = require("../TapoDiscovery");
const { TapoStreamClient } = require("../TapoStreamClient");

const log = (level, msg) => console.log(`[${level}] ${msg}`);

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === "discover") {
    console.log("Probing LAN for Tapo devices (TDP)...");
    const devices = await discoverDevices(log, 5000);
    if (!devices.length) {
      console.log("No Tapo devices found. Are you on the same LAN/VLAN?");
      return;
    }
    for (const d of devices) {
      console.log(
        `- ${d.deviceModel || "?"}  ${d.deviceName || "?"}  ip=${d.ip}  mac=${d.mac}  id=${d.deviceId || "?"}`,
      );
    }
    return;
  }

  if (cmd === "stream") {
    const [ip, cloudPassword, deviceIdOrQuality, qualityOrSeconds, secondsArg] = args;
    if (!ip || !cloudPassword) {
      console.error("Usage: node scripts/probe.js stream <ip> <cloudPassword> [deviceId] [quality] [seconds]");
      process.exit(1);
    }

    let deviceId = null;
    let quality = "HD";
    let seconds = 8;

    if (deviceIdOrQuality === "HD" || deviceIdOrQuality === "VGA") {
      quality = deviceIdOrQuality;
      seconds = Number(qualityOrSeconds) || seconds;
    } else if (deviceIdOrQuality) {
      deviceId = deviceIdOrQuality;
      if (qualityOrSeconds === "HD" || qualityOrSeconds === "VGA") {
        quality = qualityOrSeconds;
        seconds = Number(secondsArg) || seconds;
      } else {
        seconds = Number(qualityOrSeconds) || seconds;
      }
    }

    console.log(`Streaming ${quality} from ${ip}${deviceId ? ` (deviceId ${deviceId})` : ""} for ${seconds}s...`);

    const client = new TapoStreamClient(log, {
      ip,
      cloudPassword,
      username: "admin",
      deviceId,
      quality,
    });

    let bytes = 0;
    let frames = 0;
    const started = Date.now();
    const sample = [];

    client.on("data", (ts) => {
      bytes += ts.length;
      if (sample.length < 3) sample.push(ts.subarray(0, 32).toString("hex"));
    });

    try {
      await client.connect();
      console.log("Connected. Receiving MPEG-TS...");
    } catch (e) {
      console.error(`Connect failed: ${e.message}`);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, seconds * 1000));
    client.close();

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\nReceived ${bytes} bytes of TS in ${elapsed}s (~${Math.round((bytes / elapsed / 1024) * 10) / 10} KB/s)`);
    if (sample.length) console.log(`Sample TS chunks:\n${sample.join("\n")}`);
    else console.log("No TS data received — check password/hash method or that the camera is awake.");
    return;
  }

  console.error("Usage:");
  console.error("  node scripts/probe.js discover");
  console.error("  node scripts/probe.js stream <ip> <cloudPassword> [deviceId] [quality] [seconds]");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
