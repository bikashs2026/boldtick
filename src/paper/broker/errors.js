// src/paper/broker/errors.js
class BrokerError extends Error {
  constructor(code, message, raw = null) {
    super(message);
    this.code = code;
    this.raw = raw;
  }
}
module.exports = { BrokerError };
