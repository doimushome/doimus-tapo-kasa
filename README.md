# doimus-tapo-kasa

Doimus native plugin for TP-Link Tapo/Kasa devices. Supports both Kasa/Tapo smart hubs with sensors and Tapo WiFi security cameras.

## Features

### Kasa/Tapo Hubs (KH100/H100)

- Temperature/humidity sensors (T310/T315)
- Thermostats (KE100)
- Contact sensors
- Leak sensors
- Motion sensors
- Automatic device discovery and polling

### Tapo WiFi Cameras

- Privacy mode toggle (lens mask)
- Alarm sound toggle
- Notifications toggle
- Motion detection toggle
- LED indicator toggle
- Motion detection via ONVIF

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
| `pullInterval` | integer | `60000` | Status polling interval in ms |
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
| `motion` | `true` = motion detected |

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

## Credits

This plugin combines functionality from:

- [homebridge-kasa-hub](https://github.com/zmx264/homebridge-kasa-hub) by zmx264 (Apache-2.0)
- [homebridge-tapo-camera](https://github.com/kopiro/homebridge-tapo-camera) by kopiro (ISC)

Original Tapo/Kasa protocol reverse-engineering:
- [tp-link-tapo-connect](https://github.com/dickydoouk/tp-link-tapo-connect) by dickydoouk

## License

MIT
