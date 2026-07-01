const crypto = require("crypto");
const EventEmitter = require("events");

const ERROR_CODES_MAP = {
  "-40401": "Invalid stok value",
  "-40210": "Function not supported",
  "-64303": "Action cannot be done while camera is in patrol mode",
  "-64324": "Privacy mode is ON, not able to execute",
  "-64302": "Preset ID not found",
  "-64321": "Preset ID was deleted so no longer exists",
  "-40106": "Parameter to get/do does not exist",
  "-40105": "Method does not exist",
  "-40101": "Parameter to set does not exist",
  "-40209": "Invalid login credentials",
  "-64304": "Maximum Pan/Tilt range reached",
  "-71103": "User ID is not authorized",
};

class TapoCameraClient {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.cnonce = crypto.randomBytes(8).toString("hex").toUpperCase();
    this.hashedPassword = crypto
      .createHash("md5")
      .update(config.password)
      .digest("hex")
      .toUpperCase();
    this.hashedSha256Password = crypto
      .createHash("sha256")
      .update(config.password)
      .digest("hex")
      .toUpperCase();
    this.passwordEncryptionMethod = null;
    this.isSecureConnectionValue = null;
    this.stok = undefined;
    this.lsk = undefined;
    this.ivb = undefined;
    this.seq = undefined;
    this.stokPromise = null;
    this.pendingAPIRequests = new Map();
    this.MAX_LOGIN_RETRIES = 2;
    this.AES_BLOCK_SIZE = 16;
    this.onvifEvents = null;
    this.onvifDevice = null;
    this.lastMotionValue = false;
    this.SERVICE_MAP = {
      eyes: (value) => ({
        method: "setLensMaskConfig",
        params: {
          lens_mask: {
            lens_mask_info: { enabled: value ? "off" : "on" },
          },
        },
      }),
      alarm: (value) => ({
        method: "setAlertConfig",
        params: {
          msg_alarm: {
            chn1_msg_alarm_info: { enabled: value ? "on" : "off" },
          },
        },
      }),
      notifications: (value) => ({
        method: "setMsgPushConfig",
        params: {
          msg_push: {
            chn1_msg_push_info: {
              notification_enabled: value ? "on" : "off",
              rich_notification_enabled: value ? "on" : "off",
            },
          },
        },
      }),
      motionDetection: (value) => ({
        method: "setDetectionConfig",
        params: {
          motion_detection: {
            motion_det: { enabled: value ? "on" : "off" },
          },
        },
      }),
      led: (value) => ({
        method: "setLedStatus",
        params: {
          led: {
            config: { enabled: value ? "on" : "off" },
          },
        },
      }),
    };
  }

  async getEventEmitter() {
    if (this.onvifEvents) {
      return this.onvifEvents;
    }

    const { Cam } = require("onvif");

    return new Promise((resolve, reject) => {
      const device = new Cam(
        {
          hostname: this.config.ipAddress,
          username: this.config.streamUser,
          password: this.config.streamPassword,
          port: 2020,
        },
        (err) => {
          if (err) return reject(err);
          this.onvifDevice = device;
          this.onvifEvents = new EventEmitter();

          device.on("event", (event) => {
            if (
              event?.topic?._?.match(/RuleEngine\/CellMotionDetector\/Motion$/)
            ) {
              const motion = event.message.message.data.simpleItem.$.Value;
              if (motion !== this.lastMotionValue) {
                this.lastMotionValue = Boolean(motion);
                this.onvifEvents.emit("motion", this.lastMotionValue);
              }
            }
          });

          resolve(this.onvifEvents);
        },
      );
    });
  }

  getUsername() {
    return this.config.username || "admin";
  }

  getHeaders() {
    return {
      Host: `https://${this.config.ipAddress}`,
      Referer: `https://${this.config.ipAddress}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": "Tapo CameraClient Android",
      Connection: "close",
      requestByApp: "true",
      "Content-Type": "application/json; charset=UTF-8",
    };
  }

  getHashedPassword() {
    if (this.passwordEncryptionMethod === "md5") {
      return this.hashedPassword;
    } else if (this.passwordEncryptionMethod === "sha256") {
      return this.hashedSha256Password;
    } else {
      throw new Error("Unknown password encryption method");
    }
  }

  async fetch(url, data) {
    const axios = require("axios");
    const https = require("https");
    const agent = new https.Agent({
      rejectUnauthorized: false,
      ciphers: "AES256-SHA:AES128-GCM-SHA256",
    });

    return axios({
      method: "post",
      url,
      data: data.body ? JSON.parse(data.body) : undefined,
      headers: {
        ...this.getHeaders(),
        ...(data.headers || {}),
      },
      httpsAgent: agent,
      timeout: 5000,
    });
  }

  generateEncryptionToken(tokenType, nonce) {
    const hashedKey = crypto
      .createHash("sha256")
      .update(this.cnonce + this.getHashedPassword() + nonce)
      .digest("hex")
      .toUpperCase();
    return crypto
      .createHash("sha256")
      .update(tokenType + this.cnonce + nonce + hashedKey)
      .digest()
      .slice(0, 16);
  }

  getAuthenticatedStreamUrl(lowQuality = false) {
    const prefix = `rtsp://${this.config.streamUser}:${this.config.streamPassword}@${this.config.ipAddress}:554`;
    return lowQuality ? `${prefix}/stream2` : `${prefix}/stream1`;
  }

  validateDeviceConfirm(nonce, deviceConfirm) {
    this.passwordEncryptionMethod = null;

    const hashedNoncesWithSHA256 = crypto
      .createHash("sha256")
      .update(this.cnonce + this.hashedSha256Password + nonce)
      .digest("hex")
      .toUpperCase();
    if (deviceConfirm === hashedNoncesWithSHA256 + nonce + this.cnonce) {
      this.passwordEncryptionMethod = "sha256";
      return true;
    }

    const hashedNoncesWithMD5 = crypto
      .createHash("md5")
      .update(this.cnonce + this.hashedPassword + nonce)
      .digest("hex")
      .toUpperCase();
    if (deviceConfirm === hashedNoncesWithMD5 + nonce + this.cnonce) {
      this.passwordEncryptionMethod = "md5";
      return true;
    }

    return this.passwordEncryptionMethod !== null;
  }

  async refreshStok(loginRetryCount = 0) {
    this.log("debug", "refreshStok: Refreshing stok...");

    const isSecureConnection = await this.isSecureConnection();

    let fetchParams;
    if (isSecureConnection) {
      fetchParams = {
        body: JSON.stringify({
          method: "login",
          params: {
            cnonce: this.cnonce,
            encrypt_type: "3",
            username: this.getUsername(),
          },
        }),
      };
    } else {
      fetchParams = {
        body: JSON.stringify({
          method: "login",
          params: {
            username: this.getUsername(),
            password: this.hashedPassword,
            hashed: true,
          },
        }),
      };
    }

    const responseLogin = await this.fetch(
      `https://${this.config.ipAddress}`,
      fetchParams,
    );
    const responseLoginData = responseLogin.data;

    if (!responseLoginData) {
      throw new Error("Empty response login data");
    }

    if (
      responseLogin.status === 401 &&
      responseLoginData.result?.data?.code === -40411
    ) {
      throw new Error("Invalid credentials");
    }

    let response, responseData;

    if (isSecureConnection) {
      const nonce = responseLoginData.result?.data?.nonce;
      const deviceConfirm = responseLoginData.result?.data?.device_confirm;

      if (
        nonce &&
        deviceConfirm &&
        this.validateDeviceConfirm(nonce, deviceConfirm)
      ) {
        const digestPasswd = crypto
          .createHash("sha256")
          .update(this.getHashedPassword() + this.cnonce + nonce)
          .digest("hex")
          .toUpperCase();

        const digestPasswdFull = `${digestPasswd}${this.cnonce}${nonce}`;

        response = await this.fetch(`https://${this.config.ipAddress}`, {
          body: JSON.stringify({
            method: "login",
            params: {
              cnonce: this.cnonce,
              encrypt_type: "3",
              digest_passwd: digestPasswdFull,
              username: this.getUsername(),
            },
          }),
        });

        responseData = response.data;

        if (responseData.result?.start_seq) {
          if (responseData.result?.user_group !== "root") {
            throw new Error("Incorrect user_group detected");
          }

          this.lsk = this.generateEncryptionToken("lsk", nonce);
          this.ivb = this.generateEncryptionToken("ivb", nonce);
          this.seq = responseData.result.start_seq;
        }
      } else {
        if (
          responseLoginData.error_code === -40413 &&
          loginRetryCount < this.MAX_LOGIN_RETRIES
        ) {
          return this.refreshStok(loginRetryCount + 1);
        }
        throw new Error("Invalid device confirm");
      }
    } else {
      this.passwordEncryptionMethod = "md5";
      response = responseLogin;
      responseData = responseLoginData;
    }

    if (
      responseData.result?.data?.sec_left &&
      responseData.result.data.sec_left > 0
    ) {
      throw new Error(
        `Temporary Suspension: Try again in ${responseData.result.data.sec_left} seconds`,
      );
    }

    if (responseData?.result?.stok) {
      this.stok = responseData.result.stok;
      return;
    }

    if (
      responseData?.error_code === -40413 &&
      loginRetryCount < this.MAX_LOGIN_RETRIES
    ) {
      return this.refreshStok(loginRetryCount + 1);
    }

    throw new Error("Invalid authentication data");
  }

  async isSecureConnection() {
    if (this.isSecureConnectionValue === null) {
      const response = await this.fetch(`https://${this.config.ipAddress}`, {
        body: JSON.stringify({
          method: "login",
          params: {
            encrypt_type: "3",
            username: this.getUsername(),
          },
        }),
      });
      const responseData = response.data;

      this.isSecureConnectionValue =
        responseData?.error_code == -40413 &&
        String(responseData.result?.data?.encrypt_type || "").includes("3");
    }

    return this.isSecureConnectionValue;
  }

  async getStok(loginRetryCount = 0) {
    if (this.stok) {
      return this.stok;
    }

    if (!this.stokPromise) {
      this.stokPromise = this.refreshStok(loginRetryCount);
    }

    try {
      await this.stokPromise;
      if (!this.stok) {
        throw new Error("STOK not found");
      }
      return this.stok;
    } finally {
      this.stokPromise = null;
    }
  }

  encryptRequest(request) {
    const cipher = crypto.createCipheriv("aes-128-cbc", this.lsk, this.ivb);
    const blockSize = this.AES_BLOCK_SIZE;
    const padSize = blockSize - (request.length % blockSize);
    const padded = request + String.fromCharCode(padSize).repeat(padSize);
    let ctBytes = cipher.update(padded, "utf8", "hex");
    ctBytes += cipher.final("hex");
    return Buffer.from(ctBytes, "hex");
  }

  decryptResponse(response) {
    const decipher = crypto.createDecipheriv("aes-128-cbc", this.lsk, this.ivb);
    let decrypted = decipher.update(response, "base64", "utf8");
    decrypted += decipher.final("utf8");

    const paddingLength = decrypted.charCodeAt(decrypted.length - 1);
    if (
      paddingLength > this.AES_BLOCK_SIZE ||
      paddingLength > decrypted.length
    ) {
      throw new Error("Invalid padding");
    }
    for (let i = decrypted.length - paddingLength; i < decrypted.length; i++) {
      if (decrypted.charCodeAt(i) !== paddingLength) {
        throw new Error("Invalid padding");
      }
    }
    return decrypted.slice(0, decrypted.length - paddingLength);
  }

  getTapoTag(request) {
    const tag = crypto
      .createHash("sha256")
      .update(this.getHashedPassword() + this.cnonce)
      .digest("hex")
      .toUpperCase();
    return crypto
      .createHash("sha256")
      .update(tag + JSON.stringify(request) + this.seq.toString())
      .digest("hex")
      .toUpperCase();
  }

  async apiRequest(req, loginRetryCount = 0) {
    const reqJson = JSON.stringify(req);

    if (this.pendingAPIRequests.has(reqJson)) {
      return this.pendingAPIRequests.get(reqJson);
    }

    const promise = (async () => {
      try {
        const isSecureConnection = await this.isSecureConnection();
        const token = await this.getStok(loginRetryCount);
        const url = `https://${this.config.ipAddress}/stok=${token}/ds`;

        let fetchParams;

        if (this.seq && isSecureConnection) {
          const encryptedRequest = {
            method: "securePassthrough",
            params: {
              request: this.encryptRequest(JSON.stringify(req)).toString(
                "base64",
              ),
            },
          };
          fetchParams = {
            body: JSON.stringify(encryptedRequest),
            headers: {
              ...this.getHeaders(),
              Tapo_tag: this.getTapoTag(encryptedRequest),
              Seq: this.seq.toString(),
            },
          };
          this.seq += 1;
        } else {
          fetchParams = { body: JSON.stringify(req) };
        }

        const response = await this.fetch(url, fetchParams);
        let responseData;

        if (isSecureConnection) {
          const encryptedResponse = response.data;
          if (encryptedResponse?.result?.response) {
            const decryptedResponse = this.decryptResponse(
              encryptedResponse.result.response,
            );
            responseData = JSON.parse(decryptedResponse);
          }
        } else {
          responseData = response.data;
        }

        if (isSecureConnection && response.status === 500) {
          this.stok = undefined;
        }

        if (responseData && responseData.error_code !== 0) {
          const errorCode = String(responseData.error_code);
          const errorMessage = ERROR_CODES_MAP[errorCode] || "Unknown error";
          this.log(
            "debug",
            `API request failed with error code ${errorCode}: ${errorMessage}`,
          );
        }

        if (
          !responseData ||
          responseData.error_code === -40401 ||
          responseData.error_code === -1
        ) {
          this.stok = undefined;
          return this.apiRequest(req, loginRetryCount + 1);
        }

        return responseData;
      } finally {
        this.pendingAPIRequests.delete(reqJson);
      }
    })();

    this.pendingAPIRequests.set(reqJson, promise);
    return promise;
  }

  async setStatus(service, value) {
    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [this.SERVICE_MAP[service](value)],
      },
    });

    if (responseData.error_code !== 0) {
      throw new Error(`Failed to perform ${service} action`);
    }

    const method = this.SERVICE_MAP[service](value).method;
    const operation = responseData.result.responses.find(
      (e) => e.method === method,
    );
    if (operation?.error_code !== 0) {
      throw new Error(`Failed to perform ${service} action`);
    }

    return operation.result;
  }

  async getBasicInfo() {
    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [
          {
            method: "getDeviceInfo",
            params: {
              device_info: { name: ["basic_info"] },
            },
          },
        ],
      },
    });

    const info = responseData.result.responses[0];
    return info.result.device_info.basic_info;
  }

  async getSnapshot() {
    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [{ method: "getSnapshot", params: { name: ["snapshot"] } }],
      },
    });
    const op = responseData.result?.responses?.[0];
    if (op?.result?.snapshot) {
      return Buffer.from(op.result.snapshot, "base64");
    }
    return null;
  }

  async getBatteryInfo() {
    try {
      const responseData = await this.apiRequest({
        method: "multipleRequest",
        params: {
          requests: [
            {
              method: "getBatteryInfo",
              params: { battery_info: { name: ["battery_info"] } },
            },
          ],
        },
      });
      const op = responseData.result?.responses?.[0];
      if (op?.result?.battery_info) {
        return {
          percent:
            op.result.battery_info.battery_percent ??
            op.result.battery_info.percent,
          charging:
            op.result.battery_info.charging_status === "on" ||
            op.result.battery_info.charging_status === "charging",
          low:
            (op.result.battery_info.battery_percent ??
              op.result.battery_info.percent ??
              100) <= 20,
        };
      }
    } catch (_) {
      // Battery info endpoint not available — camera is likely mains-powered
    }
    return null;
  }

  async getDeviceType() {
    try {
      const info = await this.getBasicInfo();
      const model = (info?.device_model || info?.model || "").toLowerCase();
      // Detect doorbell cameras by model prefix
      if (/^(d230|d235|d210|d130)/i.test(model)) {
        return "doorbell";
      }
      return "camera";
    } catch (_) {
      return "camera";
    }
  }

  async getStatus() {
    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [
          {
            method: "getAlertConfig",
            params: { msg_alarm: { name: "chn1_msg_alarm_info" } },
          },
          {
            method: "getLensMaskConfig",
            params: { lens_mask: { name: "lens_mask_info" } },
          },
          {
            method: "getMsgPushConfig",
            params: { msg_push: { name: "chn1_msg_push_info" } },
          },
          {
            method: "getDetectionConfig",
            params: { motion_detection: { name: "motion_det" } },
          },
          { method: "getLedStatus", params: { led: { name: "config" } } },
        ],
      },
    });

    const operations = responseData.result.responses;

    const alert = operations.find((r) => r.method === "getAlertConfig");
    const lensMask = operations.find((r) => r.method === "getLensMaskConfig");
    const notifications = operations.find(
      (r) => r.method === "getMsgPushConfig",
    );
    const motionDetection = operations.find(
      (r) => r.method === "getDetectionConfig",
    );
    const led = operations.find((r) => r.method === "getLedStatus");

    return {
      alarm: alert
        ? alert.result.msg_alarm.chn1_msg_alarm_info.enabled === "on"
        : undefined,
      eyes: lensMask
        ? lensMask.result.lens_mask.lens_mask_info.enabled === "off"
        : undefined,
      notifications: notifications
        ? notifications.result.msg_push.chn1_msg_push_info
            .notification_enabled === "on"
        : undefined,
      motionDetection: motionDetection
        ? motionDetection.result.motion_detection.motion_det.enabled === "on"
        : undefined,
      led: led ? led.result.led.config.enabled === "on" : undefined,
    };
  }
}

module.exports = { TapoCameraClient };
