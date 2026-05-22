const { TapoConnect } = require("./TapoConnect");
const { TapoCameraClient } = require("./TapoCamera");

let hubDevices = new Map();
let cameraDevices = new Map();
let hubPollTimer = null;
let cameraPollTimers = new Map();

async function discoverHubDevices(cfg, api) {
  const hubsConfig = cfg.hubs;
  if (!hubsConfig?.email || !hubsConfig?.password || !hubsConfig?.devices?.length) {
    api.log("debug", "No hub configuration provided, skipping hub discovery");
    return;
  }

  const { email, password, devices, ignoreSensors } = hubsConfig;
  const deviceMap = new Map();

  for (const hubIp of devices) {
    try {
      api.log("info", `Connecting to hub at ${hubIp}...`);
      const tapoConnect = new TapoConnect((level, msg) => api.log(level, msg), email, password, hubIp);
      await tapoConnect.login();

      let index = 0;
      let totalDevices = null;

      do {
        const devicesResponse = await tapoConnect.getChildDeviceList(index);
        for (const device of TapoConnect.parseDevices(devicesResponse, tapoConnect, (level, msg) => api.log(level, msg))) {
          deviceMap.set(device.uniqueId, device);
        }

        if (totalDevices === null) {
          totalDevices = devicesResponse.sum;
        }
        index += 10;
      } while (index < (totalDevices ?? 0));
    } catch (e) {
      api.log("error", `Failed to connect to hub ${hubIp}: ${e.message}`);
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
          capabilities = ["temperature", "target_temp", "heating_state", "min_target_temp", "max_target_temp"];
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
      api.log("info", `Registered hub ${type}: ${device.name} (${device.model})`);
      hubDevices.set(did, { device, tapoConnect: device.tapoConnect });
    } else {
      hubDevices.get(did).device = device;
    }
  }

  for (const [did] of hubDevices) {
    if (!seen.has(did)) {
      hubDevices.delete(did);
      api.log("info", `Removed stale hub device: ${did}`);
    }
  }
}

async function pollHubDevices(cfg, api) {
  const hubsConfig = cfg.hubs;
  if (!hubsConfig?.email || !hubsConfig?.password || !hubsConfig?.devices?.length) {
    return;
  }

  const { ignoreSensors } = hubsConfig;

  for (const [did, state] of hubDevices) {
    if (ignoreSensors && state.device.deviceType === "temperature_humidity_sensor") {
      continue;
    }

    try {
      const deviceList = await state.tapoConnect.getChildDeviceList(0);
      const updated = TapoConnect.parseDevices(deviceList, state.tapoConnect, null).find((d) => d.uniqueId === state.device.uniqueId);

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
              const triggerLogs = await state.tapoConnect.getChildTriggerLogs(state.device.uniqueId);
              const logs = triggerLogs?.trigger_log ?? [];
              const lastEvent = logs[0];
              if (lastEvent) {
                const isOpen = lastEvent.event === "open" || lastEvent.event === "1";
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
      api.log("debug", `Poll error for hub device ${did}: ${e.message}`);
    }
  }
}

async function discoverCameras(cfg, api) {
  const cameras = cfg.cameras || [];

  const seen = new Set();

  for (const camConfig of cameras) {
    const did = `camera-${camConfig.ipAddress}`;
    seen.add(did);

    if (!cameraDevices.has(did)) {
      const client = new TapoCameraClient((level, msg) => api.log(level, msg), camConfig);

      try {
        await client.getStok();
        const status = await client.getStatus();

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

        api.registerDevice({
          id: did,
          name: camConfig.name,
          type: "camera",
          capabilities,
          state,
        });
        api.log("info", `Registered camera: ${camConfig.name} (${camConfig.ipAddress})`);
        cameraDevices.set(did, { config: camConfig, client, status });

        try {
          const eventEmitter = await client.getEventEmitter();
          eventEmitter.on("motion", (motionDetected) => {
            api.updateDeviceState(did, { motion: motionDetected });
          });
        } catch (e) {
          api.log("debug", `ONVIF motion detection unavailable for ${camConfig.name}: ${e.message}`);
        }

        const pullInterval = camConfig.pullInterval || 60000;
        const timer = setInterval(async () => {
          try {
            const newStatus = await client.getStatus();
            cameraDevices.get(did).status = newStatus;

            const updates = {};
            if (!camConfig.disablePrivacyToggle) updates.privacy_mode = !newStatus.eyes;
            if (!camConfig.disableAlarmToggle) updates.alarm = newStatus.alarm ?? false;
            if (!camConfig.disableNotificationsToggle) updates.notifications = newStatus.notifications ?? false;
            if (!camConfig.disableMotionDetectionToggle) updates.motion_detection = newStatus.motionDetection ?? false;
            if (!camConfig.disableLEDToggle) updates.led = newStatus.led ?? false;

            api.updateDeviceState(did, updates);
          } catch (e) {
            api.log("debug", `Poll error for camera ${did}: ${e.message}`);
          }

          // MJPEG frame — best-effort snapshot every poll cycle
          try {
            const frame = await client.getSnapshot();
            if (frame) {
              api.sendMjpegFrame(did, "main", frame.toString("base64"));
            }
          } catch (_) { /* snapshot is best-effort */ }
        }, pullInterval);
        if (timer.unref) timer.unref();
        cameraPollTimers.set(did, timer);
      } catch (e) {
        api.log("error", `Failed to register camera ${camConfig.name}: ${e.message}`);
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
      cameraDevices.delete(did);
      api.log("info", `Removed stale camera: ${did}`);
    }
  }
}

module.exports = {
  start(cfg, api) {
    api.log("info", "Initializing Tapo/Kasa plugin...");

    api.onCommand(async (deviceId, key, value) => {
      if (hubDevices.has(deviceId)) {
        const state = hubDevices.get(deviceId);
        const device = state.device;

        try {
          if (device.deviceType === "thermostat" && key === "target_temp") {
            await state.tapoConnect.setTempOn(value, state.device.heating_state, device.uniqueId);
            api.updateDeviceState(deviceId, { target_temp: value });
          } else if (device.deviceType === "thermostat" && key === "heating_state") {
            await state.tapoConnect.setTempOn(state.device.targetTemp, value, device.uniqueId);
            api.updateDeviceState(deviceId, { heating_state: value });
          }
        } catch (e) {
          api.log("error", `Failed to send command to hub device ${deviceId}: ${e.message}`);
        }
      } else if (cameraDevices.has(deviceId)) {
        const state = cameraDevices.get(deviceId);

        try {
          if (key === "privacy_mode") {
            await state.client.setStatus("eyes", !value);
            api.updateDeviceState(deviceId, { privacy_mode: value });
          } else if (key === "alarm") {
            await state.client.setStatus("alarm", value);
            api.updateDeviceState(deviceId, { alarm: value });
          } else if (key === "notifications") {
            await state.client.setStatus("notifications", value);
            api.updateDeviceState(deviceId, { notifications: value });
          } else if (key === "motion_detection") {
            await state.client.setStatus("motionDetection", value);
            api.updateDeviceState(deviceId, { motion_detection: value });
          } else if (key === "led") {
            await state.client.setStatus("led", value);
            api.updateDeviceState(deviceId, { led: value });
          }
        } catch (e) {
          api.log("error", `Failed to send command to camera ${deviceId}: ${e.message}`);
        }
      }
    });

    discoverHubDevices(cfg, api).catch((e) => api.log("error", `Hub discovery error: ${e.message}`));
    discoverCameras(cfg, api).catch((e) => api.log("error", `Camera discovery error: ${e.message}`));

    const pollInterval = (cfg.hubs?.pollInterval || 60) * 1000;
    hubPollTimer = setInterval(() => pollHubDevices(cfg, api).catch((e) => api.log("error", `Hub poll error: ${e.message}`)), pollInterval);
    if (hubPollTimer.unref) hubPollTimer.unref();
  },

  stop() {
    if (hubPollTimer) clearInterval(hubPollTimer);
    hubPollTimer = null;

    for (const [, timer] of cameraPollTimers) {
      clearInterval(timer);
    }
    cameraPollTimers.clear();

    hubDevices.clear();
    cameraDevices.clear();
  },
};
