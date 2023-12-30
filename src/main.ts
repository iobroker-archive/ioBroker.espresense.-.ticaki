/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';
import { Library } from './lib/library.js';
import { MQTTClientClass, MQTTServerClass } from './lib/mqtt.js';
import { genericStateObjects, statesObjects } from './lib/definition.js';
import 'source-map-support/register';

// Load your modules here, e.g.:
// import * as fs from "fs";

export class Espresense extends utils.Adapter {
    library: Library;
    mqttClient: MQTTClientClass | undefined;
    mqttServer: MQTTServerClass | undefined;
    namedDevices: { [key: string]: string } = {};
    timeout: ioBroker.Interval | undefined = undefined;
    startDelay: ioBroker.Timeout | undefined = undefined;
    unseenCheckTime: number = 5000;
    deviceDB: { [id: string]: { name: string; lc: number } } = {};
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'espresense',
        });
        this.library = new Library(this);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Reset the connection indicator during startup
        this.setStateAsync('info.connection', false, true);
        this.startDelay = this.setTimeout(async () => {
            await this.library.init();
            await this.library.initStates(await this.getStatesAsync('*'));
            this.library.defaults.updateStateOnChangeOnly = false;

            await this.library.writedp('devices', undefined, genericStateObjects.devices);
            await this.library.writedp('rooms', undefined, genericStateObjects.rooms);
            await this.library.writedp('settings', undefined, genericStateObjects.settings);
            await this.library.writedp('global', undefined, genericStateObjects.global);
            for (const id in statesObjects.rooms) {
                //@ts-expect-error id is keyof
                const obj = statesObjects.rooms[id];
                if (obj && obj.common && obj.common.write === true) {
                    const val = this.library.readdb(`global.${id}`);
                    if (val == undefined) {
                        const val: any =
                            obj.common.type == 'string'
                                ? ''
                                : obj.common.type == 'number'
                                  ? -1
                                  : obj.common.type == 'boolean'
                                    ? false
                                    : null;
                        await this.library.writedp(`global.${id}`, val, obj, false);
                    }
                }
            }
            const temp = this.library.readdb('deviceDB');
            if (temp && temp.val && typeof temp.val == 'string') {
                this.deviceDB = JSON.parse(temp.val);
            }

            await this.subscribeStatesAsync('rooms.*');
            await this.subscribeStatesAsync('global.*');
            this.namedDevices = {};
            //check config
            let testIt: any = this.config.MQTTServerIp;
            if ((testIt == '' || typeof testIt != 'string') && !this.config.MQTTUseServer) {
                this.log.error(`Invalid configuration mqtt server ip has unexpeted value: ${testIt}`);
                return;
            }
            testIt = this.config.MQTTServerPort;
            if (typeof testIt != 'number' || testIt <= 1023) {
                this.log.error(`Invalid configuration mqtt server port has unexpeted value: ${testIt}`);
                return;
            }
            testIt = this.config.MQTTPassword;
            if (typeof testIt != 'string') {
                this.log.error(`Invalid configuration mqtt server password has unexpeted value type ${typeof testIt}`);
                return;
            }
            testIt = this.config.MQTTUsername;
            if (typeof testIt != 'string') {
                this.log.error(`Invalid configuration mqtt username has unexpeted value typ: ${typeof testIt}`);
                return;
            }
            testIt = this.config.unseenTime;
            if (isNaN(testIt) || testIt == '' || testIt < 5) {
                this.config.unseenTime = 20;
            }
            testIt = this.config.selectedDevices;
            if (typeof testIt != 'object' || !Array.isArray(testIt)) {
                this.config.selectedDevices = [];
            } else {
                this.config.selectedDevices = this.config.selectedDevices.filter((a) => {
                    return typeof a.id == 'string' && a.id != '';
                });
            }
            this.config.unseenTime *= 1000;
            // configuration ok
            // refresh states
            if ((this.config.selectedDevices || []).length > 0) {
                await this.library.cleanUpTree(
                    this.config.selectedDevices.map((a) => `devices.${this.library.cleandp(a.id, false, true)}`),
                    [`devices.`],
                    -1,
                );
            }
            await this.library.initStates(await this.getStatesAsync('*'));

            if (this.config.MQTTUseServer) {
                this.mqttServer = new MQTTServerClass(
                    this,
                    this.config.MQTTServerPort,
                    this.config.MQTTUsername,
                    this.config.MQTTPassword,
                    utils.getAbsoluteInstanceDataDir(this),
                );
            }
            this.mqttClient = new MQTTClientClass(
                this,
                this.config.MQTTUseServer ? '127.0.0.1' : this.config.MQTTServerIp,
                this.config.MQTTServerPort,
                this.config.MQTTUsername,
                this.config.MQTTPassword,
            );
            this.timeout = this.setInterval(() => {
                this.library.garbageColleting('devices.', this.config.unseenTime);
            }, this.unseenCheckTime);
            if (!this.config.retainGlobal) {
                for (const id in statesObjects.rooms) {
                    const topic = `espresense/rooms/*/${id}/set`;
                    if (this.mqttClient) {
                        await this.mqttClient.publish(topic, '', { retain: true });
                    }
                }
            }
        }, 1000);
    }

    async handleMessage(topic: string, message: any): Promise<void> {
        if (!topic || message == undefined) return;
        const topicA = topic.split('/');
        topicA.shift();
        const typTemp = topicA.shift();
        if (typTemp !== 'rooms' && typTemp !== 'settings' && typTemp !== 'devices') return;
        const typ: 'settings' | 'devices' | 'rooms' = typTemp;
        const temp = this.library.cloneGenericObject(statesObjects[typ]._channel) as ioBroker.DeviceObject;

        let device = topicA.shift();
        device = device ? device : 'no_name';
        if (message && message.name && message.id) {
            this.namedDevices[message.id] = message.name;
        }
        temp.common.name = this.namedDevices[device] || device;
        if (typ === 'settings' && message.name) temp.common.name = message.name;
        if (typ === 'devices') {
            this.deviceDB[device] = { name: this.namedDevices[device] || device, lc: Date.now() };
            this.library.writedp('deviceDB', JSON.stringify(this.deviceDB), genericStateObjects.deviceDB);
            if (this.config.selectedDevices.length > 0) {
                if (
                    this.config.selectedDevices.findIndex((i) => {
                        return i.id === device;
                    }) == -1
                )
                    return;
            }
        }
        device = this.library.cleandp(device, false, true);
        if (typ !== 'rooms' && device != '*') await this.library.writedp(`${typ}.${device}`, undefined, temp);

        if (typ === 'rooms') {
            // ignore set commands
            let path = `${typ}.${device}`;
            if (device == '*') {
                path = 'global';
                if (topicA[topicA.length - 1] == 'set') topicA.pop();
            } else if (topicA[topicA.length - 1] == 'set') {
                return;
            }

            const data: any = {};
            data[topicA.join('.')] = message;
            try {
                data.restart = false;
                await this.library.writeFromJson(path, typ, statesObjects, data);
            } catch (e: any) {
                this.log.error(e);
                this.log.error(`Topic:${topic} data: ${JSON.stringify(data)}`);
            }
        } else if (typ === 'settings') {
            const data: any = {};
            this.namedDevices[message.id] = message.name;

            data[topicA.join('.')] = message;
            await this.library.writeFromJson(`${typ}.${device}`, typ, statesObjects, data);
        } else if (typ === 'devices') {
            let subDevice = topicA.shift();
            subDevice = subDevice ? subDevice : 'no_name';
            subDevice = this.library.cleandp(subDevice, false, true);
            const temp = this.library.cloneGenericObject(statesObjects[typ]._channel) as ioBroker.DeviceObject;
            temp.common.name = this.namedDevices[subDevice] || subDevice;
            await this.library.writedp(`${typ}.${device}.${subDevice}`, undefined, temp);
            await this.library.writedp(`${typ}.${device}.presense`, true, genericStateObjects.presense);
            await this.library.writeFromJson(`${typ}.${device}.${subDevice}`, typ, statesObjects, message);
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            if (this.mqttClient) this.mqttClient.destroy();
            if (this.mqttServer) this.mqttServer.destroy();
            if (this.timeout) this.clearInterval(this.timeout);
            if (this.startDelay) this.clearTimeout(this.startDelay);
            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (state && !state.ack) {
            id = id.replace(`${this.namespace}.`, '');
            this.library.setdb(id, 'state', state.val, undefined, state.ack, state.ts);
            const dbEntry = this.library.readdb(id);
            if (dbEntry && dbEntry.obj && dbEntry.obj.common && dbEntry.obj.common.write) {
                const native = dbEntry.obj.native;
                let val = dbEntry.val;
                if (native && native.convert) {
                    const fn = new Function('val', `return ${native.convert}`);
                    val = fn(val);
                }
                const global = id.split('.')[1] === 'global';
                const topic = global
                    ? `espresense/rooms/*/${id.split('.')[2]}/set`
                    : `espresense/${id.split('.').join('/')}/set`;
                if (this.mqttClient) {
                    await this.mqttClient.publish(topic, String(val), {
                        retain: id.endsWith('.restart') ? false : !!this.config.retainGlobal,
                    });
                }
            }
        } else {
        }
    }

    //If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     */
    private onMessage(obj: ioBroker.Message): void {
        if (typeof obj === 'object' && obj.message) {
            switch (obj.command) {
                case 'getDevices':
                    {
                        let result: { label: string; value: string }[] = [];
                        for (const id in this.config.selectedDevices) {
                            result.push({
                                label: this.config.selectedDevices[id].name,
                                value: this.config.selectedDevices[id].id,
                            });
                        }
                        for (const id in this.deviceDB) {
                            const data = this.deviceDB[id];
                            if (data.lc < Date.now() - 300000) {
                                delete this.deviceDB[id];
                                continue;
                            } else {
                                if (id == '') continue;
                                if (data.name == '') data.name = id;
                                result.push({ label: data.name, value: id });
                            }
                        }
                        result = result.filter(
                            (a, b) =>
                                result.findIndex((c) => {
                                    return c.value == a.value;
                                }) == b,
                        );
                        this.library.writedp('deviceDB', JSON.stringify(this.deviceDB), genericStateObjects.deviceDB);
                        if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
                    }
                    break;
                case 'addDevice':
                    {
                        if (
                            this.config.selectedDevices.findIndex((i) => {
                                return i.id == obj.message.id;
                            }) == -1
                        ) {
                            this.config.selectedDevices.push({
                                id: obj.message.id,
                                name:
                                    (this.deviceDB[obj.message.id] && this.deviceDB[obj.message.id].name) ||
                                    obj.message.id,
                            });
                        }
                        if (obj.callback)
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { native: { selectedDevices: this.config.selectedDevices } },
                                obj.callback,
                            );
                    }
                    break;
                case 'removeDevice':
                    {
                        if (
                            this.config.selectedDevices.findIndex((i) => {
                                i.id == obj.message.id;
                            }) != -1
                        ) {
                            this.config.selectedDevices.splice(
                                this.config.selectedDevices.findIndex((i) => {
                                    i.id == obj.message.id;
                                }),
                                1,
                            );
                        }
                        if (obj.callback)
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { native: { selectedDevices: this.config.selectedDevices } },
                                obj.callback,
                            );
                    }
                    break;
            }
            if (obj.command === 'send') {
                // e.g. send email or pushover or whatever
                this.log.info('send command');

                // Send response in callback if required
                if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Espresense(options);
} else {
    // otherwise start the instance directly
    (() => new Espresense())();
}
