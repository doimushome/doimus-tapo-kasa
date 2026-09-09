const axios = require("axios");
const { randomUUID } = require("crypto");

const CLOUD_URL = "https://wap.tplinkcloud.com";

// Minimal Tapo cloud client: login + device list. This is the same legacy
// endpoint the official app uses to enumerate devices by account.
class TapoCloudClient {
  constructor(log, email, password) {
    this.log = log;
    this.email = email;
    this.password = password;
    this.token = null;
    this.terminalUUID = randomUUID();
  }

  async _post(data, token) {
    const response = await axios({
      method: "post",
      url: CLOUD_URL,
      params: token ? { token } : undefined,
      data,
      timeout: 20000,
    });
    const body = response.data;
    if (!body) throw new Error("Empty cloud response");
    if (body.error_code !== 0) {
      const code = body.error_code;
      let msg = body.msg || "unknown";
      if (code === -20651) msg = "Token expired";
      else if (code === -20601 || code === -20600) msg = "Incorrect email or password";
      throw new Error(`Cloud error ${code}: ${msg}`);
    }
    return body.result;
  }

  async login() {
    const result = await this._post({
      method: "login",
      params: {
        appType: "Tapo_Android",
        cloudUserName: this.email,
        cloudPassword: this.password,
        terminalUUID: this.terminalUUID,
      },
    });
    if (!result?.token) throw new Error("Cloud login returned no token");
    this.token = result.token;
    this.log?.("debug", "[TapoCloud] cloud login ok");
    return this.token;
  }

  async getDeviceList() {
    if (!this.token) await this.login();
    const result = await this._post({ method: "getDeviceList" }, this.token);
    const list = result?.deviceList || [];
    this.log?.("debug", `[TapoCloud] cloud returned ${list.length} devices`);
    return list;
  }
}

module.exports = { TapoCloudClient };
