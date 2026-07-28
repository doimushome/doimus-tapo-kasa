const { TapoConnect } = require("./TapoConnect");
const { TapoCameraClient } = require("./TapoCamera");

function createLogger(api, prefix) {
  return (level, msg) => log(level, `[${prefix}] ${msg}`);
}

let log = null;

let hubDevices = new Map();
let cameraDevices = new Map();
let hubPollTimer = null;
let cameraPollTimers = new Map();
let savedApi = null;
// Live view: deviceId → ffmpeg child process
let liveViewProcesses = new Map();
// Snapshot cooldown: deviceId → last snapshot timestamp (ms)
let snapshotCooldowns = new Map();

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
            heating_state: device.sleep ? 0 : 1,
            min_target_temp: device.minControlTemp ?? 5,
            max_target_temp: device.maxControlTemp ?? 30,
          };
          break;
        case "contact_sensor":
          type = "sensor";
          capabilities = ["contact", "battery_low"];
          state = {
            contact: !!device.contactOpen,
            battery_low: device.atLowBattery ?? false,
          };
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
      });
      log(
        "info",
        `Registered hub ${type}: ${device.name} (${device.model})`,
      );
      hubDevices.set(did, { device, tapoConnect: device.tapoConnect });
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

  for (const [did, state] of hubDevices) {
    if (
      ignoreSensors &&
      state.device.deviceType === "temperature_humidity_sensor"
    ) {
      continue;
    }

    try {
      const deviceList = await state.tapoConnect.getChildDeviceList(0);
      const updated = TapoConnect.parseDevices(
        deviceList,
        state.tapoConnect,
        null,
      ).find((d) => d.uniqueId === state.device.uniqueId);

      if (updated) {
        state.device = updated;

        switch (updated.deviceType) {
          case "temperature_humidity_sensor":
            api.updateDeviceState(did, {
              temperature: updated.currentTemp ?? state.device.currentTemp,
              humidity: updated.currentHumidity ?? state.device.currentHumidity,
              battery_low: updated.atLowBattery ?? false,
            });
            break;
          case "thermostat":
            api.updateDeviceState(did, {
              temperature: updated.currentTemp ?? state.device.currentTemp,
              target_temp: updated.targetTemp ?? state.device.targetTemp,
              heating_state: updated.sleep ? 0 : 1,
            });
            break;
          case "contact_sensor":
            try {
              const triggerLogs = await state.tapoConnect.getChildTriggerLogs(
                state.device.uniqueId,
              );
              const logs = triggerLogs?.trigger_log ?? [];
              const lastEvent = logs[0];
              if (lastEvent) {
                const isOpen =
                  lastEvent.event === "open" || lastEvent.event === "1";
                api.updateDeviceState(did, {
                  contact: isOpen,
                  battery_low: updated.atLowBattery ?? false,
                });
              } else {
                api.updateDeviceState(did, {
                  contact: !!updated.contactOpen,
                  battery_low: updated.atLowBattery ?? false,
                });
              }
            } catch {
              api.updateDeviceState(did, {
                contact: !!updated.contactOpen,
                battery_low: updated.atLowBattery ?? false,
              });
            }
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
      log("debug", `Poll error for hub device ${did}: ${e.message}`);
    }
  }
}

// ── Snapshot capture + dual-store (MJPEG + Image history) ──────────────
async function captureAndStoreSnapshot(did, camConfig, client, api) {
  try {
    const frame = await client.getSnapshot();
    if (!frame || frame.length === 0) return;

    // MJPEG stream for live subscribers
    api.sendMjpegFrame(did, "main", frame);

    // Image history store — enables static snapshot retrieval in the mobile app
    api.updateDeviceImage(did, "snapshot_latest", frame, "image/jpeg");
  } catch (err) {
    log("error", "Snapshot error: " + err.message);
  }
}

// ── RTSP → MJPEG relay for live view (p2p_start / p2p_stop) ───────────
async function startLiveView(did, camConfig, api) {
  if (liveViewProcesses.has(did)) {
    log("debug", `Live view already active for ${camConfig.name}`);
    return;
  }

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

    let buffer = Buffer.alloc(0);
    const SOI = Buffer.from([0xff, 0xd8]);
    const EOI = Buffer.from([0xff, 0xd9]);

    proc.stderr.on("data", (data) => {
      log("debug", "ffmpeg: " + data.toString());
    });

    proc.stdout.on("data", (chunk) => {
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
        }
      }
    });

    proc.on("error", (err) => {
      log(
        "error",
        `Live view ffmpeg error for ${camConfig.name}: ${err.message}`,
      );
      liveViewProcesses.delete(did);
    });

    proc.on("close", (code) => {
      log("info", `Live view stopped for ${camConfig.name} (code=${code})`);
      liveViewProcesses.delete(did);
    });

    liveViewProcesses.set(did, proc);
  } catch (e) {
    log(
      "error",
      `Failed to start live view for ${camConfig.name}: ${e.message}`,
    );
  }
}

function stopLiveView(did, api) {
  const proc = liveViewProcesses.get(did);
  if (!proc) return;
  log("info", `Stopping live view for ${did}`);
  try {
    proc.kill("SIGTERM");
  } catch (_) {}
  liveViewProcesses.delete(did);
}

// ── Camera discovery ──────────────────────────────────────────────────
function makeCameraId(camConfig) {
  const crypto = require("crypto");
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ name: camConfig.name, user: camConfig.streamUser }))
    .digest("hex")
    .slice(0, 16);
  return `camera-${hash}`;
}

async function discoverCameras(cfg, api) {
  const cameras = cfg.cameras || [];

  const seen = new Set();

  for (const camConfig of cameras) {
    const did = makeCameraId(camConfig);
    seen.add(did);

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
        api.registerDevice({
          id: did,
          name: camConfig.name,
          type: finalType,
          capabilities,
          state,
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

        // ── ONVIF motion detection ─────────────────────────────────
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
                captureAndStoreSnapshot(did, camConfig, client, api);
              }
            }
          });
        } catch (e) {
          log(
            "debug",
            `ONVIF motion detection unavailable for ${camConfig.name}: ${e.message}`,
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
            await captureAndStoreSnapshot(did, camConfig, client, api);
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
      stopLiveView(did, api);
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
            startLiveView(deviceId, camState.config, api);
          } else if (key === "p2p_stop") {
            stopLiveView(deviceId, api);
          }
          // ── WebRTC signaling relay from mobile app ─────────────
          else if (key === "webrtc" && value && typeof value === "object") {
            if (value.action === "start") {
              startLiveView(deviceId, camState.config, api);
            } else if (value.action === "stop") {
              stopLiveView(deviceId, api);
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
  },

  stop() {
    if (hubPollTimer) clearInterval(hubPollTimer);
    hubPollTimer = null;

    for (const [, timer] of cameraPollTimers) {
      clearInterval(timer);
    }
    cameraPollTimers.clear();

    for (const [did] of liveViewProcesses) {
      stopLiveView(did, savedApi);
    }
    liveViewProcesses.clear();
    snapshotCooldowns.clear();

    hubDevices.clear();
    cameraDevices.clear();
  },
  setConfig(cfg) {
    this.stop();
    this.start(cfg, savedApi);
  },
};
