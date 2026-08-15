const crypto = require("crypto");
const { TapoConnect } = require("./TapoConnect");
const { TapoCameraClient } = require("./TapoCamera");
const { TapoCloudClient } = require("./TapoCloudClient");
const { TapoStreamClient } = require("./TapoStreamClient");
const { discoverDevices, detectSubnet } = require("./TapoDiscovery");

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

let log = null;

let hubDevices = new Map();
let cameraDevices = new Map();
let hubPollTimer = null;
let cameraPollTimers = new Map();
let cameraDiscoveryTimer = null;
let savedApi = null;
// Hub re-login cooldown: hub IP → timestamp of last re-login attempt (ms).
// Prevents hammering an unreachable/rejecting hub on every poll.
let hubReconnectCooldowns = new Map();
const HUB_RECONNECT_COOLDOWN_MS = 60 * 1000;
// Live view: deviceId → ffmpeg child process
let liveViewProcesses = new Map();
// Snapshot cooldown: deviceId → last snapshot timestamp (ms)
let snapshotCooldowns = new Map();
// Doorbell auto-reset: deviceId → timeout handle
let doorbellTimers = new Map();

// Trigger-log response shapes vary across hub firmware generations. Try the
// common control_child envelope first, then a few direct-response forms.
function extractTriggerLogs(response) {
  const r = response?.responseData?.result?.responses?.[0]?.result;
  if (Array.isArray(r?.logs)) return r.logs;
  if (Array.isArray(response?.logs)) return response.logs;
  if (Array.isArray(response?.trigger_log)) return response.trigger_log;
  return null;
}

// Maps a trigger-log event to a contact state. Returns undefined for events
// that do not express a contact change.
function eventToContactState(event) {
  if (event === "open" || event === "1") return true;
  if (event === "close" || event === "0") return false;
  if (event === "keepOpen") return true; // emitted when the sensor stays open >1min
  return undefined;
}

// Logged once per sensor so the response shape is visible at debug level.
const loggedTriggerShapes = new Set();

async function readTriggerLogs(device, tapoConnect) {
  try {
    const response = await tapoConnect.getChildTriggerLogs(device.uniqueId);
    const logs = extractTriggerLogs(response);
    if (!logs?.length) return null;
    if (!loggedTriggerShapes.has(device.uniqueId)) {
      loggedTriggerShapes.add(device.uniqueId);
      log(
        "debug",
        `Trigger log shape for ${device.name}: ${JSON.stringify(response).slice(0, 400)}`,
      );
    }
    return logs;
  } catch (e) {
    log("debug", `Trigger log fetch failed for ${device.name}: ${e.message}`);
    return null;
  }
}

async function resolveContactState(device, tapoConnect, logs) {
  // The `open` field in get_child_device_list can lag for battery sensors;
  // the last trigger event is the authoritative current state.
  if (logs === undefined) logs = await readTriggerLogs(device, tapoConnect);
  const current = eventToContactState(logs?.[0]?.event);
  if (current !== undefined) return current;
  return typeof device.contactOpen === "boolean" ? device.contactOpen : false;
}

// Replays newly seen open/close events as individual state updates so every
// transition (even ones that revert between polls) lands in the timeline.
async function updateContactSensorState(did, device, state, api) {
  const battery = device.atLowBattery ?? false;
  const logs = await readTriggerLogs(device, state.tapoConnect);

  if (logs?.length) {
    const lastId = state.triggerLogId || 0;
    let newestId = lastId;
    const fresh = [];
    for (const entry of logs) {
      const id = Number(entry?.id);
      if (Number.isFinite(id) && id > lastId) {
        fresh.push(entry);
        if (id > newestId) newestId = id;
      }
    }
    fresh.sort((a, b) => Number(a.id) - Number(b.id));

    for (const entry of fresh) {
      const next = eventToContactState(entry.event);
      if (next !== undefined) {
        api.updateDeviceState(did, { contact: next, battery_low: battery });
      }
    }
    if (newestId > lastId) state.triggerLogId = newestId;

    // The newest log event always reflects the current state; push it so the
    // value stays accurate even when no new events arrived this poll.
    const current = eventToContactState(logs[0].event);
    if (current !== undefined) {
      api.updateDeviceState(did, { contact: current, battery_low: battery });
      return;
    }
  }

  // No readable trigger logs — fall back to the (possibly lagging) open field.
  api.updateDeviceState(did, {
    contact: await resolveContactState(device, state.tapoConnect, logs),
    battery_low: battery,
  });
}

async function discoverHubDevices(cfg, api) {
  const hubsConfig = cfg.hubs;
  if (
    !hubsConfig?.email ||
    !hubsConfig?.password ||
    !hubsConfig?.devices?.length
  ) {
    log("debug", "No hub configuration provided, skipping hub discovery");
    return;
  }

  const { email, password, devices, ignoreSensors } = hubsConfig;
  const deviceMap = new Map();

  for (const hubIp of devices) {
    try {
      log("info", `Connecting to hub at ${hubIp}...`);
      const tapoConnect = new TapoConnect(
        (level, msg) => log(level, msg),
        email,
        password,
        hubIp,
      );
      await tapoConnect.login();

      let index = 0;
      let totalDevices = null;

      do {
        const devicesResponse = await tapoConnect.getChildDeviceList(index);
        for (const device of TapoConnect.parseDevices(
          devicesResponse,
          tapoConnect,
          (level, msg) => log(level, msg),
        )) {
          deviceMap.set(device.uniqueId, device);
        }

        if (totalDevices === null) {
          totalDevices = devicesResponse.sum;
        }
        index += 10;
      } while (index < (totalDevices ?? 0));
    } catch (e) {
      log("error", `Failed to connect to hub ${hubIp}: ${e.message}`);
    }
  }

  const seen = new Set();

  for (const [uniqueId, device] of deviceMap) {
    if (ignoreSensors && device.deviceType === "temperature_humidity_sensor") {
      continue;
    }

    const did = `hub-${uniqueId}`;
    seen.add(did);

    if (!hubDevices.has(did)) {
      let type, capabilities, state;
      let triggerLogId = 0;
      let metadata = undefined;

      switch (device.deviceType) {
        case "temperature_humidity_sensor":
          type = "sensor";
          capabilities = ["temperature", "humidity", "battery_low"];
          state = {
            temperature: device.currentTemp ?? 0,
            humidity: device.currentHumidity ?? 0,
            battery_low: device.atLowBattery ?? false,
          };
          break;
        case "temperature_sensor":
          type = "sensor";
          capabilities = ["temperature", "battery_low"];
          state = {
            temperature: device.currentTemp ?? 0,
            battery_low: device.atLowBattery ?? false,
          };
          break;
        case "humidity_sensor":
          type = "sensor";
          capabilities = ["humidity", "battery_low"];
          state = {
            humidity: device.currentHumidity ?? 0,
            battery_low: device.atLowBattery ?? false,
          };
          break;
        case "thermostat":
          type = "thermostat";
          capabilities = [
            "temperature",
            "target_temp",
            "heating_state",
            "min_target_temp",
            "max_target_temp",
          ];
          state = {
            temperature: device.currentTemp ?? 0,
            target_temp: device.targetTemp ?? 0,
            heating_state: device.frostProtectionOn ? 0 : 1,
            min_target_temp: device.minControlTemp ?? 5,
            max_target_temp: device.maxControlTemp ?? 30,
          };
          metadata = {
            ui: {
              sections: [
                {
                  title: "Thermostat",
                  rows: [
                    {
                      type: "stepper",
                      key: "target_temp",
                      label: "Target temperature",
                      min_key: "min_target_temp",
                      max_key: "max_target_temp",
                      step: 1,
                      unit: "celsius",
                    },
                    {
                      type: "value",
                      key: "temperature",
                      label: "Current temperature",
                      unit: "celsius",
                    },
                    {
                      type: "segment",
                      key: "heating_state",
                      label: "Mode",
                      options: [
                        { value: 1, label: "On" },
                        { value: 0, label: "Frost" },
                      ],
                    },
                  ],
                },
              ],
            },
          };
          break;
        case "contact_sensor":
          type = "sensor";
          capabilities = ["contact", "battery_low"];
          const contactLogs = await readTriggerLogs(device, device.tapoConnect);
          state = {
            contact: await resolveContactState(
              device,
              device.tapoConnect,
              contactLogs,
            ),
            battery_low: device.atLowBattery ?? false,
          };
          triggerLogId = contactLogs?.length
            ? Number(contactLogs[0].id) || 0
            : 0;
          break;
        case "leak_sensor":
          type = "sensor";
          capabilities = ["leak", "battery_low"];
          state = {
            leak: device.leakDetected ?? false,
            battery_low: device.atLowBattery ?? false,
          };
          break;
        case "motion_sensor":
          type = "sensor";
          capabilities = ["motion", "battery_low"];
          state = {
            motion: device.motionDetected ?? false,
            battery_low: device.atLowBattery ?? false,
          };
          break;
        default:
          continue;
      }

      api.registerDevice({
        id: did,
        name: device.name,
        type,
        capabilities,
        state,
        metadata,
      });
      log(
        "info",
        `Registered hub ${type}: ${device.name} (${device.model})`,
      );
      hubDevices.set(did, {
        device,
        tapoConnect: device.tapoConnect,
        triggerLogId,
      });
    } else {
      hubDevices.get(did).device = device;
    }
  }

  for (const [did] of hubDevices) {
    if (!seen.has(did)) {
      hubDevices.delete(did);
      log("info", `Removed stale hub device: ${did}`);
    }
  }
}

async function pollHubDevices(cfg, api) {
  const hubsConfig = cfg.hubs;
  if (
    !hubsConfig?.email ||
    !hubsConfig?.password ||
    !hubsConfig?.devices?.length
  ) {
    return;
  }

  const { ignoreSensors } = hubsConfig;

  const byHub = new Map();
  for (const [did, state] of hubDevices) {
    const list = byHub.get(state.tapoConnect) || [];
    list.push({ did, state });
    byHub.set(state.tapoConnect, list);
  }

  for (const [tapoConnect, devices] of byHub) {
    try {
      const all = await fetchHubDeviceList(tapoConnect, devices, ignoreSensors, api);
      if (!all) continue;

      for (const { did, state } of devices) {
        if (
          ignoreSensors &&
          state.device.deviceType === "temperature_humidity_sensor"
        ) {
          continue;
        }

        const updated = all.get(state.device.uniqueId);
        if (!updated) continue;

        state.device = updated;

        switch (updated.deviceType) {
          case "temperature_humidity_sensor":
            api.updateDeviceState(did, {
              temperature: updated.currentTemp ?? state.device.currentTemp,
              humidity: updated.currentHumidity ?? state.device.currentHumidity,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
          case "temperature_sensor":
            api.updateDeviceState(did, {
              temperature: updated.currentTemp ?? state.device.currentTemp,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
          case "humidity_sensor":
            api.updateDeviceState(did, {
              humidity: updated.currentHumidity ?? state.device.currentHumidity,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
          case "thermostat":
            api.updateDeviceState(did, {
              temperature: updated.currentTemp ?? state.device.currentTemp,
              target_temp: updated.targetTemp ?? state.device.targetTemp,
              heating_state: updated.frostProtectionOn ? 0 : 1,
            });
            break;
          case "contact_sensor":
            await updateContactSensorState(did, updated, state, api);
            break;
          case "leak_sensor":
            api.updateDeviceState(did, {
              leak: updated.leakDetected ?? false,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
          case "motion_sensor":
            api.updateDeviceState(did, {
              motion: updated.motionDetected ?? false,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
        }
      }
    } catch (e) {
      log("error", `Poll error for hub: ${e.message}`);
    }
  }
}

// Fetches the child device list for a hub, re-logging in once if the session
// has gone stale (TP-Link hub sessions expire and return 403 otherwise).
// Returns a Map of uniqueId → device, or null if both attempts failed.
async function fetchHubDeviceList(tapoConnect, devices, ignoreSensors, api) {
  const hubIp = tapoConnect.deviceIp || "unknown";

  try {
    return await fetchHubDevicePage(tapoConnect);
  } catch (firstErr) {
    const now = Date.now();
    const lastRetry = hubReconnectCooldowns.get(hubIp) || 0;
    if (now - lastRetry < HUB_RECONNECT_COOLDOWN_MS) {
      log("debug", `Hub ${hubIp} poll failed (${firstErr.message}); re-login on cooldown, skipping`);
      return null;
    }
    hubReconnectCooldowns.set(hubIp, now);
    log("warn", `Hub ${hubIp} poll failed (${firstErr.message}) — re-logging in and retrying`);
    try {
      await tapoConnect.login();
      return await fetchHubDevicePage(tapoConnect);
    } catch (retryErr) {
      log("error", `Hub ${hubIp} re-login + retry failed: ${retryErr.message}`);
      return null;
    }
  }
}

async function fetchHubDevicePage(tapoConnect) {
  const all = new Map();
  let index = 0;
  let totalDevices = null;

  do {
    const page = await tapoConnect.getChildDeviceList(index);
    for (const d of TapoConnect.parseDevices(page, tapoConnect, null)) {
      all.set(d.uniqueId, d);
    }
    if (totalDevices === null) {
      totalDevices = page.sum;
    }
    index += 10;
  } while (index < (totalDevices ?? 0));

  return all;
}

// ── Snapshot capture + dual-store (MJPEG + Image history) ──────────────
async function captureAndStoreSnapshot(did, client, api) {
  try {
    const frame = await client.getSnapshot();
    if (!frame || frame.length === 0) return;

    // MJPEG stream for live subscribers
    api.sendMjpegFrame(did, "main", frame);

    // Image history + live-view key so the snapshot is retrievable in the app
    api.updateDeviceImage(did, "snapshot_latest", frame, "image/jpeg");
    api.updateDeviceImage(did, "snapshot_live", frame, "image/jpeg");
  } catch (err) {
    log("error", "Snapshot error: " + err.message);
  }
}

// ── Live view relay (p2p_start / p2p_stop) ─────────────────────────────
// Two transports:
//   RTSP  — `rtsp://ip:554/stream1` → ffmpeg → MJPEG (mains cameras)
//   P2P   — proprietary TCP/8800 media protocol → ffmpeg → MJPEG (all
//           cameras, required for battery/doorbell models without RTSP)
function shouldUseP2P(camConfig) {
  if (camConfig.streamMode === "rtsp") return false;
  if (camConfig.streamMode === "p2p") return true;
  if (camConfig.batteryPowered) return true;
  // auto: default to RTSP only when RTSP credentials are configured
  return !camConfig.streamUser || !camConfig.streamPassword;
}

async function startLiveView(did, camState, api) {
  if (liveViewProcesses.has(did)) {
    log("debug", `Live view already active for ${camState.config.name}`);
    return;
  }

  if (shouldUseP2P(camState.config)) {
    await startP2pLiveView(did, camState, api);
  } else {
    await startRtspLiveView(did, camState.config, api);
  }
}

// MPEG-TS byte-alignment: the camera's multipart bodies aren't aligned to
// 188-byte TS packets (each part may start/end mid-packet). ffmpeg's demuxer
// needs aligned packets, so sync on the 0x47 sync byte and emit only complete
// 188-byte packets — same as pytapo's streamer does.
function createTsAligner(emit) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 188 && buffer[0] !== 0x47) {
      const idx = buffer.indexOf(0x47, 1);
      if (idx === -1) {
        buffer = Buffer.alloc(0);
        return;
      }
      buffer = buffer.subarray(idx);
    }
    while (buffer.length >= 188) {
      emit(buffer.subarray(0, 188));
      buffer = buffer.subarray(188);
    }
  };
}

function makeMpegFrameHandler(did, api) {
  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Extract complete JPEG frames from the MJPEG pipe stream
    while (true) {
      const soiIdx = buffer.indexOf(SOI);
      if (soiIdx === -1) break;

      const eoiIdx = buffer.indexOf(EOI, soiIdx + 2);
      if (eoiIdx === -1) break;

      const jpeg = buffer.subarray(soiIdx, eoiIdx + 2);
      buffer = buffer.subarray(eoiIdx + 2);

      if (jpeg.length > 0) {
        api.sendMjpegFrame(did, "main", jpeg);
        api.updateDeviceImage(did, "snapshot_latest", jpeg, "image/jpeg");
        // LiveViewSheet requests `snapshot_live` for the full-screen view.
        api.updateDeviceImage(did, "snapshot_live", jpeg, "image/jpeg");
      }
    }
  };
}

// Wires the shared ffmpeg plumbing for both live-view transports: debug logs
// from stderr, MJPEG frame extraction from stdout, and process cleanup.
function wireFfmpeg(proc, did, name, api) {
  proc.stderr.on("data", (data) => {
    log("debug", "ffmpeg: " + data.toString());
  });
  proc.stdout.on("data", makeMpegFrameHandler(did, api));

  const cleanup = () => liveViewProcesses.delete(did);
  proc.on("error", (err) => {
    log("error", `Live view ffmpeg error for ${name}: ${err.message}`);
    cleanup();
  });
  proc.on("close", (code) => {
    log(
      "info",
      `Live view stopped for ${name}${code !== undefined ? ` (code=${code})` : ""}`,
    );
    cleanup();
  });
}

async function startRtspLiveView(did, camConfig, api) {
  const rtspUrl = `rtsp://${camConfig.streamUser}:${camConfig.streamPassword}@${camConfig.ipAddress}:554/stream1`;

  log("info", `Starting live view for ${camConfig.name} via ${rtspUrl}`);

  try {
    const { spawn } = require("child_process");
    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        rtspUrl,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "10",
        "-r",
        "5", // 5 fps is enough for live view
        "-vf",
        "scale=640:-1", // scale down for bandwidth
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    wireFfmpeg(proc, did, camConfig.name, api);

    liveViewProcesses.set(did, {
      stop: () => {
        try {
          proc.kill("SIGTERM");
        } catch (_) {}
      },
    });
  } catch (e) {
    log(
      "error",
      `Failed to start live view for ${camConfig.name}: ${e.message}`,
    );
  }
}

// Proprietary TCP/8800 media protocol: digest-auth the camera, pull MPEG-TS,
// feed ffmpeg stdin, relay MJPEG frames to the app.
async function startP2pLiveView(did, camState, api) {
  const camConfig = camState.config;
  const { spawn } = require("child_process");

  log(
    "info",
    `Starting live view for ${camConfig.name} via P2P (${camConfig.ipAddress}:8800)`,
  );

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-probesize",
      "65536",
      "-analyzeduration",
      "500000",
      "-f",
      "mpegts",
      "-i",
      "pipe:0",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "10",
      "-r",
      "5",
      "-vf",
      "scale=640:-1",
      "-f",
      "mjpeg",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  wireFfmpeg(ffmpeg, did, camConfig.name, api);

  const client = new TapoStreamClient(
    (level, msg) => log(level, msg),
    {
      ip: camConfig.ipAddress,
      cloudPassword: camConfig.password,
      username: camConfig.username || "admin",
      deviceId: camConfig.deviceId || null,
      quality: camConfig.streamQuality || "HD",
    },
  );

  let streamError = null;
  const alignTs = createTsAligner((ts) => {
    if (streamError || !ffmpeg.stdin || ffmpeg.stdin.destroyed) return;
    ffmpeg.stdin.write(ts);
  });
  client.on("data", alignTs);
  client.on("error", (err) => {
    streamError = err;
    log("error", `P2P stream error for ${camConfig.name}: ${err.message}`);
  });
  client.on("close", () => {
    log("debug", `P2P stream closed for ${camConfig.name}`);
  });

  liveViewProcesses.set(did, {
    stop: () => {
      client.close();
      try {
        ffmpeg.kill("SIGTERM");
      } catch (_) {}
    },
  });

  // Battery cameras wake slowly; retry the 8800 connect a few times.
  const maxAttempts = camConfig.batteryPowered ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connect();
      log("info", `P2P stream connected for ${camConfig.name}`);
      return;
    } catch (err) {
      log(
        "warn",
        `P2P connect attempt ${attempt}/${maxAttempts} failed for ${camConfig.name}: ${err.message}`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  log(
    "error",
    `Giving up on P2P stream for ${camConfig.name} — is the camera awake?`,
  );
  client.close();
  try {
    ffmpeg.kill("SIGTERM");
  } catch (_) {}
  liveViewProcesses.delete(did);
}

function stopLiveView(did) {
  const handle = liveViewProcesses.get(did);
  if (!handle) return;
  log("info", `Stopping live view for ${did}`);
  try {
    handle.stop();
  } catch (_) {}
  liveViewProcesses.delete(did);
}

// ── Camera discovery ──────────────────────────────────────────────────
function makeCameraId(camConfig) {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        name: camConfig.name,
        user: camConfig.streamUser,
        deviceId: camConfig.deviceId,
        mac: camConfig.mac,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `camera-${hash}`;
}

// Doorbell/battery model prefixes: no RTSP/ONVIF, must stream over the
// proprietary TCP/8800 media protocol.
const BATTERY_CAMERA_MODEL = /^(c420|c425|c402|c403|c410|c700|c710|c720|d230|d235|d210|d130)/i;

function isBatteryCameraModel(model) {
  return BATTERY_CAMERA_MODEL.test(model || "");
}

function isDoorbellModel(model) {
  return /^(d230|d235|d210|d130)/i.test(model || "");
}

// Cloud device list → camera configs, resolving LAN IPs via TDP discovery
// (matched by MAC, same as the official app). Returns
//   { configs: Map key → config, deviceIds: Set }
// `deviceIds` lists every camera in the account so asleep/battery cameras
// that aren't on the LAN right now can be retained by the caller.
async function discoverCamerasFromCloud(cfg) {
  const hubsConfig = cfg.hubs;
  if (!hubsConfig?.email || !hubsConfig?.password) {
    log("debug", "No cloud credentials, skipping camera cloud discovery");
    return { configs: new Map(), deviceIds: new Set() };
  }

  const cloud = new TapoCloudClient(
    (level, msg) => log(level, msg),
    hubsConfig.email,
    hubsConfig.password,
  );

  let list;
  try {
    list = await cloud.getDeviceList();
  } catch (e) {
    log("error", `Camera cloud discovery failed: ${e.message}`);
    return { configs: new Map(), deviceIds: new Set() };
  }

  const cloudCameras = list.filter((d) => {
    const type = String(d.deviceType || "").toUpperCase();
    return (
      type.includes("TAPOCAMERA") ||
      type.includes("IPCAMERA") ||
      isDoorbellModel(d.deviceModel)
    );
  });
  const deviceIds = new Set(
    cloudCameras.map((d) => d.deviceId).filter(Boolean),
  );
  if (!cloudCameras.length) return { configs: new Map(), deviceIds };

  log("debug", `Cloud lists ${cloudCameras.length} camera device(s), probing LAN…`);
  // Determine the LAN subnet: explicit config wins; otherwise auto-detect
  // from the route table (works on the Pi with host networking). Broadcast
  // is used when no subnet can be determined.
  const subnet =
    cfg.cloud?.subnet ||
    detectSubnet() ||
    null;
  const tdpDevices = await discoverDevices(
    (level, msg) => log(level, msg),
    cfg.cloud?.discoveryTimeout || 4000,
    subnet,
  );
  const byMac = new Map(
    tdpDevices.map((d) => [d.mac.replace(/[:-]/g, "").toLowerCase(), d]),
  );

  const configs = new Map();
  for (const dev of cloudCameras) {
    const mac = (dev.deviceMac || dev.mac || "")
      .replace(/[:-]/g, "")
      .toLowerCase();
    const tdp = mac ? byMac.get(mac) : null;
    if (!tdp) {
      log(
        "debug",
        `No LAN device found for ${dev.deviceName} (mac ${mac || "?"}); camera asleep or on another VLAN`,
      );
      continue;
    }

    const model = dev.deviceModel || tdp.deviceModel || "";
    const config = {
      name: dev.deviceName || dev.alias || tdp.deviceName || model,
      ipAddress: tdp.ip,
      deviceId: dev.deviceId || tdp.deviceId,
      mac,
      username: "admin",
      password: hubsConfig.password,
      batteryPowered: isBatteryCameraModel(model),
      streamMode: "p2p",
      fromCloud: true,
      deviceModel: model,
    };
    configs.set(config.deviceId || config.mac, config);
  }
  log("info", `Cloud discovery resolved ${configs.size} camera(s) on the LAN`);
  return { configs, deviceIds };
}

async function discoverCameras(cfg, api) {
  const cameras = cfg.cameras || [];

  const seen = new Set();

  // Merge manually configured cameras with cloud-discovered ones. Manual
  // configs win when they match a cloud device by MAC or name. Registered
  // cloud cameras that are still in the account but asleep/off-LAN right now
  // are retained with their last known config instead of being dropped.
  const { configs: cloudConfigs, deviceIds: cloudDeviceIds } =
    cfg.cloud?.discoverCameras === false
      ? { configs: new Map(), deviceIds: new Set() }
      : await discoverCamerasFromCloud(cfg);

  const merged = new Map();
  for (const [, cc] of cloudConfigs) {
    merged.set(cc.mac, cc);
  }
  for (const [did, state] of cameraDevices) {
    const cfgEntry = state.config;
    if (
      cfgEntry?.fromCloud &&
      cfgEntry.deviceId &&
      cloudDeviceIds.has(cfgEntry.deviceId) &&
      !merged.has(cfgEntry.mac)
    ) {
      merged.set(cfgEntry.mac, cfgEntry);
    }
  }
  for (const manual of cameras) {
    if (!manual?.name && !manual?.ipAddress) continue;
    const key = manual.mac || (manual.ipAddress && manual.name);
    merged.set(key || `manual-${manual.name}`, manual);
  }

  for (const camConfig of merged.values()) {
    // Skip empty camera rows (left behind by the app config editor)
    if (!camConfig?.name && !camConfig?.ipAddress) {
      continue;
    }

    const did = makeCameraId(camConfig);
    seen.add(did);

    if (
      !camConfig?.ipAddress ||
      !camConfig?.password ||
      !camConfig?.username
    ) {
      log(
        "warn",
        `Skipping camera '${camConfig?.name || "unnamed"}': ipAddress, username and password are required to connect`,
      );
      continue;
    }

    if (!cameraDevices.has(did)) {
      const client = new TapoCameraClient(
        (level, msg) => log(level, msg),
        camConfig,
      );

      try {
        await client.getStok();
        const status = await client.getStatus();
        const deviceType = await client.getDeviceType();
        const isDoorbell = deviceType === "doorbell";
        const isBatteryPowered = camConfig.batteryPowered || false;

        const capabilities = [];
        const state = {};

        if (!camConfig.disablePrivacyToggle) {
          capabilities.push("privacy_mode");
          state.privacy_mode = !status.eyes;
        }
        if (!camConfig.disableAlarmToggle) {
          capabilities.push("alarm");
          state.alarm = status.alarm ?? false;
        }
        if (!camConfig.disableNotificationsToggle) {
          capabilities.push("notifications");
          state.notifications = status.notifications ?? false;
        }
        if (!camConfig.disableMotionDetectionToggle) {
          capabilities.push("motion_detection");
          state.motion_detection = status.motionDetection ?? false;
        }
        if (!camConfig.disableLEDToggle) {
          capabilities.push("led");
          state.led = status.led ?? false;
        }

        capabilities.push("motion");
        state.motion = false;

        // Live view via RTSP → MJPEG relay
        capabilities.push("p2p_start");
        capabilities.push("p2p_stop");

        // Camera present (drives camera UI in the app)
        capabilities.push("video");

        // Doorbell support
        if (isDoorbell) {
          capabilities.push("doorbell");
          state.doorbell = false;
        }

        // Battery support for battery-powered cameras
        if (isBatteryPowered && !camConfig.disableBatteryReporting) {
          const batteryInfo = await client.getBatteryInfo();
          if (batteryInfo) {
            capabilities.push("battery");
            state.battery = batteryInfo.percent ?? 100;
            capabilities.push("battery_low");
            state.battery_low = batteryInfo.low ?? false;
          }
        }

        const finalType = isDoorbell ? "doorbell" : "camera";

        const uiRows = [];
        if (!camConfig.disablePrivacyToggle) {
          uiRows.push({ type: "toggle", key: "privacy_mode", label: "Privacy mode" });
        }
        if (!camConfig.disableAlarmToggle) {
          uiRows.push({ type: "toggle", key: "alarm", label: "Alarm" });
        }
        if (!camConfig.disableNotificationsToggle) {
          uiRows.push({ type: "toggle", key: "notifications", label: "Notifications" });
        }
        if (!camConfig.disableMotionDetectionToggle) {
          uiRows.push({ type: "toggle", key: "motion_detection", label: "Motion detection" });
        }
        if (!camConfig.disableLEDToggle) {
          uiRows.push({ type: "toggle", key: "led", label: "Status LED" });
        }
        uiRows.push({ type: "button", key: "p2p_start", label: "Live view" });

        api.registerDevice({
          id: did,
          name: camConfig.name,
          type: finalType,
          capabilities,
          state,
          metadata: {
            ui: {
              sections: [{ title: "Camera", rows: uiRows }],
            },
          },
        });
        log(
          "info",
          `Registered ${finalType}: ${camConfig.name} (${camConfig.ipAddress})`,
        );
        cameraDevices.set(did, {
          config: camConfig,
          client,
          status,
          isDoorbell,
          isBatteryPowered,
        });

        // ── ONVIF event detection (motion + doorbell) ─────────────────
        try {
          const eventEmitter = await client.getEventEmitter();
          eventEmitter.on("motion", (motionDetected) => {
            api.updateDeviceState(did, { motion: motionDetected });
            // Event-driven snapshot capture: trigger on motion start
            if (motionDetected && camConfig.snapshotOnMotion) {
              const now = Date.now();
              const cooldownMs = camConfig.snapshotCooldown || 5000;
              const last = snapshotCooldowns.get(did) || 0;
              if (now - last >= cooldownMs) {
                snapshotCooldowns.set(did, now);
                captureAndStoreSnapshot(did, client, api);
              }
            }
          });
          if (isDoorbell) {
            eventEmitter.on("doorbell", (pressed) => {
              if (pressed) {
                if (doorbellTimers.has(did)) {
                  clearTimeout(doorbellTimers.get(did));
                }
                api.updateDeviceState(did, { doorbell: true });
                doorbellTimers.set(
                  did,
                  setTimeout(() => {
                    api.updateDeviceState(did, { doorbell: false });
                    doorbellTimers.delete(did);
                  }, 5000),
                );
              }
            });
          }
        } catch (e) {
          log(
            "debug",
            `ONVIF event detection unavailable for ${camConfig.name}: ${e.message}`,
          );
        }

        // ── Periodic status + snapshot poll ────────────────────────
        const pullInterval = camConfig.pullInterval || 60000;
        const timer = setInterval(async () => {
          try {
            const newStatus = await client.getStatus();
            cameraDevices.get(did).status = newStatus;

            const updates = {};
            if (!camConfig.disablePrivacyToggle)
              updates.privacy_mode = !newStatus.eyes;
            if (!camConfig.disableAlarmToggle)
              updates.alarm = newStatus.alarm ?? false;
            if (!camConfig.disableNotificationsToggle)
              updates.notifications = newStatus.notifications ?? false;
            if (!camConfig.disableMotionDetectionToggle)
              updates.motion_detection = newStatus.motionDetection ?? false;
            if (!camConfig.disableLEDToggle)
              updates.led = newStatus.led ?? false;

            // Battery update for battery-powered cameras
            if (isBatteryPowered && !camConfig.disableBatteryReporting) {
              const batteryInfo = await client.getBatteryInfo();
              if (batteryInfo) {
                updates.battery = batteryInfo.percent ?? 100;
                updates.battery_low = batteryInfo.low ?? false;
              }
            }

            api.updateDeviceState(did, updates);
          } catch (e) {
            log("debug", `Poll error for camera ${did}: ${e.message}`);
          }

          // Periodic snapshot capture (when ONVIF motion is unavailable or snapshotOnMotion is disabled)
          if (!camConfig.snapshotOnMotion) {
            await captureAndStoreSnapshot(did, client, api);
          }
        }, pullInterval);
        if (timer.unref) timer.unref();
        cameraPollTimers.set(did, timer);
      } catch (e) {
        log(
          "error",
          `Failed to register camera ${camConfig.name}: ${e.message}`,
        );
      }
    } else {
      cameraDevices.get(did).config = camConfig;
    }
  }

  for (const [did] of cameraDevices) {
    if (!seen.has(did)) {
      if (cameraPollTimers.has(did)) {
        clearInterval(cameraPollTimers.get(did));
        cameraPollTimers.delete(did);
      }
      stopLiveView(did);
      if (doorbellTimers.has(did)) {
        clearTimeout(doorbellTimers.get(did));
        doorbellTimers.delete(did);
      }
      snapshotCooldowns.delete(did);
      cameraDevices.delete(did);
      log("info", `Removed stale camera: ${did}`);
    }
  }
}

module.exports = {
  start(cfg, api) {
    savedApi = api;
    log = createLogger(api, "TapoKasa");
    log("info", "Initializing Tapo/Kasa plugin...");

    api.onCommand(async (deviceId, key, value) => {
      if (hubDevices.has(deviceId)) {
        const state = hubDevices.get(deviceId);
        const device = state.device;

        try {
          if (device.deviceType === "thermostat" && key === "target_temp") {
            await state.tapoConnect.setTempOn(
              value,
              state.device.heating_state,
              device.uniqueId,
            );
            api.updateDeviceState(deviceId, { target_temp: value });
          } else if (
            device.deviceType === "thermostat" &&
            key === "heating_state"
          ) {
            await state.tapoConnect.setTempOn(
              state.device.targetTemp,
              value,
              device.uniqueId,
            );
            api.updateDeviceState(deviceId, { heating_state: value });
          }
        } catch (e) {
          log(
            "error",
            `Failed to send command to hub device ${deviceId}: ${e.message}`,
          );
        }
      } else if (cameraDevices.has(deviceId)) {
        const camState = cameraDevices.get(deviceId);

        try {
          // ── Standard camera toggles ──────────────────────────────
          if (key === "privacy_mode") {
            await camState.client.setStatus("eyes", !value);
            api.updateDeviceState(deviceId, { privacy_mode: value });
          } else if (key === "alarm") {
            await camState.client.setStatus("alarm", value);
            api.updateDeviceState(deviceId, { alarm: value });
          } else if (key === "notifications") {
            await camState.client.setStatus("notifications", value);
            api.updateDeviceState(deviceId, { notifications: value });
          } else if (key === "motion_detection") {
            await camState.client.setStatus("motionDetection", value);
            api.updateDeviceState(deviceId, { motion_detection: value });
          } else if (key === "led") {
            await camState.client.setStatus("led", value);
            api.updateDeviceState(deviceId, { led: value });
          }
          // ── Live view commands (p2p_start / p2p_stop) ──────────
          else if (key === "p2p_start") {
            startLiveView(deviceId, camState, api);
          } else if (key === "p2p_stop") {
            stopLiveView(deviceId);
          }
          // ── WebRTC signaling relay from mobile app ─────────────
          else if (key === "webrtc" && value && typeof value === "object") {
            if (value.action === "start") {
              startLiveView(deviceId, camState, api);
            } else if (value.action === "stop") {
              stopLiveView(deviceId);
            }
          }
        } catch (e) {
          log(
            "error",
            `Failed to send command to camera ${deviceId}: ${e.message}`,
          );
        }
      }
    });

    discoverHubDevices(cfg, api).catch((e) =>
      log("error", `Hub discovery error: ${e.message}`),
    );
    discoverCameras(cfg, api).catch((e) =>
      log("error", `Camera discovery error: ${e.message}`),
    );

    const pollInterval = (cfg.hubs?.pollInterval || 60) * 1000;
    hubPollTimer = setInterval(
      () =>
        pollHubDevices(cfg, api).catch((e) =>
          log("error", `Hub poll error: ${e.message}`),
        ),
      pollInterval,
    );
    if (hubPollTimer.unref) hubPollTimer.unref();

    // Periodic camera re-discovery: sleeping battery cameras and cameras
    // that failed to register at startup get retried, and newly added
    // cameras are picked up without a plugin restart.
    const discoveryInterval = (cfg.cloud?.discoveryInterval ?? 300000);
    if (discoveryInterval > 0) {
      cameraDiscoveryTimer = setInterval(
        () =>
          discoverCameras(cfg, api).catch((e) =>
            log("error", `Camera re-discovery error: ${e.message}`),
          ),
        discoveryInterval,
      );
      if (cameraDiscoveryTimer.unref) cameraDiscoveryTimer.unref();
    }
  },

  stop() {
    if (hubPollTimer) clearInterval(hubPollTimer);
    hubPollTimer = null;

    if (cameraDiscoveryTimer) clearInterval(cameraDiscoveryTimer);
    cameraDiscoveryTimer = null;

    for (const [, timer] of cameraPollTimers) {
      clearInterval(timer);
    }
    cameraPollTimers.clear();

    for (const [did] of liveViewProcesses) {
      stopLiveView(did);
    }
    liveViewProcesses.clear();
    for (const [did, timeout] of doorbellTimers) {
      clearTimeout(timeout);
    }
    doorbellTimers.clear();
    snapshotCooldowns.clear();
    hubReconnectCooldowns.clear();
    loggedTriggerShapes.clear();

    hubDevices.clear();
    cameraDevices.clear();
  },
  setConfig(cfg) {
    this.stop();
    this.start(cfg, savedApi);
  },
};
