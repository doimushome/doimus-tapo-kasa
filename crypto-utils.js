const crypto = require("crypto");

function hashPassword(password, method) {
  if (method === "sha256") {
    return crypto
      .createHash("sha256")
      .update(password)
      .digest("hex")
      .toUpperCase();
  }
  return crypto.createHash("md5").update(password).digest("hex").toUpperCase();
}

function md5Hex(...parts) {
  return crypto
    .createHash("md5")
    .update(parts.join(":"))
    .digest("hex");
}

function sha256Hex(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.join(":"))
    .digest("hex");
}

module.exports = { hashPassword, md5Hex, sha256Hex };
