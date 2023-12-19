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
    timeoutDelete: ioBroker.Interval | undefined = undefined;
    unseenCheckTime: number = 10000;
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'espresense',
        });
        this.library = new Library(this);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Reset the connection indicator during startup
        this.setStateAsync('info.connection', false, true);

        await this.library.init();
        await this.library.initStates(await this.getStatesAsync('*'));
        this.library.defaults.updateStateOnChangeOnly = false;

        this.library.writedp('devices', undefined, genericStateObjects.devices);
        this.library.writedp('rooms', undefined, genericStateObjects.rooms);
        this.library.writedp('settings', undefined, genericStateObjects.configs);

        this.namedDevices = {};
        //check config
        let testIt: any = this.config.MQTTServerIp;
        if (testIt == '' || typeof testIt != 'string') {
            this.log.warn(`Invalid configuration mqtt server ip has unexpeted value: ${testIt}`);
            return;
        }
        testIt = this.config.MQTTServerPort;
        if (typeof testIt != 'number' || testIt <= 1023) {
            this.log.warn(`Invalid configuration mqtt server port has unexpeted value: ${testIt}`);
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
        this.config.unseenTime *= 1000;
        // configuration ok
        if (this.config.MQTTUseServer) {
            this.mqttServer = new MQTTServerClass(
                this,
                this.config.MQTTServerPort,
                this.config.MQTTUsername,
                this.config.MQTTPassword,
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
        this.timeoutDelete = this.setInterval(() => {
            this.library.garbageColleting('devices.', 2592000000, true);
        }, 3600000);
    }

    async handleMessage(topic: string, message: any): Promise<void> {
        if (!topic || message == undefined) return;
        const topicA = topic.split('/');
        topicA.shift();
        const typ = topicA.shift();
        if (typ !== 'rooms' && typ !== 'settings' && typ !== 'devices') return;
        const temp = this.library.cloneGenericObject(statesObjects[typ]._channel) as ioBroker.DeviceObject;

        let device = topicA.shift();
        device = device ? device : 'no_name';
        if (message && typeof message.name && message.id) {
            this.namedDevices[message.id] = message.name;
        }
        temp.common.name = this.namedDevices[device] || device;

        await this.library.writedp(`${typ}.${device}`, undefined, temp);

        if (typ === 'rooms') {
            const data: any = {};
            data[topicA.join('.')] = message;
            await this.library.writeFromJson(`${typ}.${device}`, typ, statesObjects, data);
        } else if (typ === 'settings') {
            const data: any = {};
            this.namedDevices[message.id] = message.name;

            const states = await this.library.getStates(`\\.${message.id}\\.`);
            for (const dp in states) {
                if (states[dp] !== undefined)
                    this.library.setdb(
                        dp,
                        states[dp]!.type,
                        states[dp]!.val,
                        states[dp]!.stateTyp,
                        states[dp]!.ack,
                        states[dp]!.ts,
                        true,
                    );
            }

            data[topicA.join('.')] = message;
            await this.library.writeFromJson(`${typ}.${device}`, typ, statesObjects, data);
            if (typ === 'settings') this.log.debug(JSON.stringify(data));
        } else if (typ === 'devices') {
            let subDevice = topicA.shift();
            subDevice = subDevice ? subDevice : 'no_name';
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
            if (this.timeoutDelete) this.clearInterval(this.timeoutDelete);
            if (this.timeout) this.clearInterval(this.timeout);
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
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  */
    // private onMessage(obj: ioBroker.Message): void {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Espresense(options);
} else {
    // otherwise start the instance directly
    (() => new Espresense())();
}
