# doimus-tapo-kasa

Doimus native plugin for TP-Link Tapo/Kasa devices. Supports both Kasa/Tapo smart hubs with sensors and Tapo WiFi security cameras (including battery-powered models and doorbells).

## Features

### Kasa/Tapo Hubs (KH100/H100)

- Temperature/humidity sensors (T310/T315)
- Thermostats (KE100)
- Contact sensors
- Leak sensors
- Motion sensors
- Automatic device discovery and polling

### Tapo WiFi Cameras & Doorbells

- Privacy mode toggle (lens mask)
- Alarm sound toggle
- Notifications toggle
- Motion detection toggle
- LED indicator toggle
- Motion detection via ONVIF
- **Live view** via RTSP → MJPEG relay (requires ffmpeg on the host)
- **Battery level reporting** for battery-powered cameras (C420, C425, D230, etc.)
- **Doorbell** detection and doorbell press events (D230, D235, D210, D130)
- **Event-driven snapshots** — capture on ONVIF motion events instead of constant polling (battery-friendly)
- **Image history** — snapshots stored in backend image store for retrieval when not actively streaming

## Configuration

### Hub Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hubs.email` | string | — | Your Tapo/Kasa account email |
| `hubs.password` | string | — | Your Tapo/Kasa account password |
| `hubs.devices` | array | — | IP addresses of your hubs |
| `hubs.ignoreSensors` | boolean | `false` | Ignore temperature/humidity sensors |
| `hubs.pollInterval` | integer | `60` | Polling interval in seconds (5-3600) |

### Camera Configuration

Each camera in the `cameras` array:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — | Display name for the camera |
| `ipAddress` | string | — | Camera IP address |
| `username` | string | `admin` | Camera username |
| `password` | string | — | Tapo account password |
| `streamUser` | string | — | RTSP stream username (from Camera Account settings) |
| `streamPassword` | string | — | RTSP stream password (from Camera Account settings) |
| `batteryPowered` | boolean | `false` | Enable for battery-powered cameras (C420, C425, D230, D235) |
| `disableBatteryReporting` | boolean | `false` | Skip battery status queries |
| `pullInterval` | integer | `60000` | Status polling interval in ms |
| `snapshotOnMotion` | boolean | `true` | Capture snapshots only on ONVIF motion events (battery-friendly) |
| `snapshotCooldown` | integer | `5000` | Minimum ms between motion-triggered snapshots |
| `disablePrivacyToggle` | boolean | `false` | Disable privacy mode toggle |
| `disableAlarmToggle` | boolean | `false` | Disable alarm toggle |
| `disableNotificationsToggle` | boolean | `false` | Disable notifications toggle |
| `disableMotionDetectionToggle` | boolean | `false` | Disable motion detection toggle |
| `disableLEDToggle` | boolean | `false` | Disable LED toggle |

## Device Capabilities

### Hub Sensors

| Device Type | Capabilities |
|-------------|-------------|
| Temperature/Humidity Sensor | `temperature`, `humidity`, `battery_low` |
| Thermostat | `temperature`, `target_temp`, `heating_state`, `min_target_temp`, `max_target_temp` |
| Contact Sensor | `contact`, `battery_low` |
| Leak Sensor | `leak`, `battery_low` |
| Motion Sensor | `motion`, `battery_low` |

### Cameras

| Capability | Description |
|------------|-------------|
| `privacy_mode` | `true` = privacy mode enabled (lens covered) |
| `alarm` | `true` = alarm sound enabled |
| `notifications` | `true` = push notifications enabled |
| `motion_detection` | `true` = motion detection enabled |
| `led` | `true` = LED indicator on |
| `motion` | `true` = motion detected (via ONVIF) |
| `p2p_start` | Start live view (RTSP → MJPEG relay via ffmpeg) |
| `p2p_stop` | Stop live view |

### Battery-Powered Cameras

When `batteryPowered: true` is set, the following additional capabilities are available:

| Capability | Description |
|------------|-------------|
| `battery` | Battery percentage (0-100) |
| `battery_low` | `true` when battery ≤ 20% |

### Doorbell Cameras

Tapo doorbell cameras (D230, D235, D210, D130) are auto-detected by model prefix. Additional capabilities:

| Capability | Description |
|------------|-------------|
| `doorbell` | `true` when doorbell button is pressed (via ONVIF event) |

## Live View

The plugin supports live view via RTSP → MJPEG relay. When enabled, the mobile app can start/stop live streaming:

- **Start**: Mobile sends `p2p_start` command → plugin spawns ffmpeg to pull RTSP stream and push MJPEG frames
- **Stop**: Mobile sends `p2p_stop` command → plugin kills ffmpeg

**Requirements**: `ffmpeg` must be installed on the host running Doimus. On Orange Pi / Raspberry Pi: `sudo apt install ffmpeg`.

The stream is bandwidth-optimized: 5 fps at 640px width with quality level 10.

## Camera Setup

For firmware build 230921 and higher, enable third-party compatibility:

1. Open the Tapo app
2. Go to "Me" (bottom right)
3. Tap "Tapo Lab"
4. Go to "Third-Party Compatibility"
5. Set to "On"

To find RTSP credentials:
- Tapo app > Settings > Advanced Settings > Camera Account
- Username must be alphanumeric only (no special characters)

### Battery Camera Notes

For battery-powered Tapo cameras (C420, C425, D230, D235):

1. Set `batteryPowered: true` in the camera config
2. `snapshotOnMotion` defaults to `true` — snapshots are only captured when ONVIF motion is detected, saving battery
3. The camera's battery level and low-battery status are polled during status updates

## Credits

This plugin combines functionality from:

- [homebridge-kasa-hub](https://github.com/zmx264/homebridge-kasa-hub) by zmx264 (Apache-2.0)
- [homebridge-tapo-camera](https://github.com/kopiro/homebridge-tapo-camera) by kopiro (ISC)

Original Tapo/Kasa protocol reverse-engineering:
- [tp-link-tapo-connect](https://github.com/dickydoouk/tp-link-tapo-connect) by dickydoouk

## License

MIT
