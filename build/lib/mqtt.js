"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mqtt_exports = {};
__export(mqtt_exports, {
  MQTTClientClass: () => MQTTClientClass,
  MQTTServerClass: () => MQTTServerClass
});
module.exports = __toCommonJS(mqtt_exports);
var import_mqtt = __toESM(require("mqtt"));
var import_library = require("./library");
var import_aedes = __toESM(require("aedes"));
var import_net = require("net");
class MQTTClientClass extends import_library.BaseClass {
  callback;
  client;
  data = {};
  constructor(adapter, ip, port, username, password, callback) {
    super(adapter, "mqttClient");
    this.callback = callback;
    this.client = import_mqtt.default.connect(`mqtt://${ip}:${port}`, { username, password });
    this.client.on("connect", () => {
      this.log.info(`connection is active.`);
      this.adapter.setState("info.connection", true, true);
      this.client.subscribe("espresense/#", (err) => {
        if (err) {
          this.log.error(`On subscribe: ${err}`);
        }
      });
    });
    this.client.on("disconnect", () => {
      this.adapter.setState("info.connection", false, true);
      this.log.debug(`disconnected`);
    });
    this.client.on("error", (err) => {
      this.log.error(`${err}`);
    });
    this.client.on("close", () => {
      this.adapter.setState("info.connection", false, true);
      this.log.info(`connection is closed.`);
    });
    this.client.on("message", (topic, message) => {
      let value;
      let type = "";
      try {
        value = JSON.parse(message.toString());
        if (typeof value == "string")
          throw new Error("nope");
        type = typeof value;
      } catch (e) {
        value = message.toString();
        if (isNaN(value)) {
          if (value == "ON" || value == "OFF") {
            type = "boolean";
            value = value == "ON";
          } else {
            type = "string";
          }
        } else if (value == "") {
          type = "string";
        } else {
          type = "number1";
          this.log.debug(typeof value);
          value = parseFloat(value);
        }
      }
      const test = topic.split("/");
      const key = test.pop();
      if (this.data[test.join("_")] === void 0)
        this.data[test.join("_")] = {};
      if (key !== void 0)
        this.data[test.join("_")][key] = value;
      this.log.debug(`${topic}: ${type} - ${value}`);
      this.callback(topic, value);
    });
  }
  destroy() {
    this.client.end();
  }
}
class MQTTServerClass extends import_library.BaseClass {
  aedes;
  server;
  constructor(adapter, port, username, password) {
    super(adapter, "mqttServer");
    this.aedes = new import_aedes.default();
    this.server = (0, import_net.createServer)(this.aedes.handle);
    this.server.listen(port, () => {
      this.log.debug("server started and listening on port ", String(port));
    });
    this.aedes.authenticate = (client, un, pw, callback) => {
      const confirm = username === un && password == pw.toString();
      if (!confirm)
        this.log.warn("MQTT client login denied. User name or password wrong!");
      else
        this.log.debug("MQTT client login successful.");
      callback(null, confirm);
    };
  }
  destroy() {
    this.aedes.close();
    this.server.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MQTTClientClass,
  MQTTServerClass
});
//# sourceMappingURL=mqtt.js.map
