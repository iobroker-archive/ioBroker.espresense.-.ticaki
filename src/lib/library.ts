import _fs from 'fs';
import type { statesObjectsType } from './definition';
// eslint-disable-next-line
import { genericStateObjects, statesObjects } from './definition';
import type { Espresense } from '../main';

// only change this for other adapters
export type AdapterClassDefinition = Espresense;

export type LibraryStateVal = LibraryStateValJson | undefined;
type LibraryStateValJson = {
    type: ioBroker.ObjectType;
    stateTyp: string | undefined;
    val: ioBroker.StateValue | undefined;
    ts: number;
    ack: boolean;
    obj: ioBroker.Object | undefined;
    init: boolean;
};

// Generic library module and base classes, do not insert specific adapter code here.

/**
 * Base class with this.log function
 */
export class BaseClass {
    unload: boolean = false;
    log: CustomLog;
    adapter: AdapterClassDefinition;
    library: Library;
    name: string = ``;
    constructor(adapter: AdapterClassDefinition, name: string = '') {
        this.name = name;
        this.log = new CustomLog(adapter, this.name);
        this.adapter = adapter;
        this.library = adapter.library;
    }
    delete(): void {
        this.unload = true;
    }
}

class CustomLog {
    #adapter: AdapterClassDefinition;
    #prefix: string;
    constructor(adapter: AdapterClassDefinition, text: string = '') {
        this.#adapter = adapter;
        this.#prefix = text;
    }
    getName(): string {
        return this.#prefix;
    }
    debug(log: string, log2: string = ''): void {
        this.#adapter.log.debug(log2 ? `[${log}] ${log2}` : `[${this.#prefix}] ${log}`);
    }
    info(log: string, log2: string = ''): void {
        this.#adapter.log.info(log2 ? `[${log}] ${log2}` : `[${this.#prefix}] ${log}`);
    }
    warn(log: string, log2: string = ''): void {
        this.#adapter.log.warn(log2 ? `[${log}] ${log2}` : `[${this.#prefix}] ${log}`);
    }
    error(log: string, log2: string = ''): void {
        this.#adapter.log.error(log2 ? `[${log}] ${log2}` : `[${this.#prefix}] ${log}`);
    }
    setLogPrefix(text: string): void {
        this.#prefix = text;
    }
}

export class Library extends BaseClass {
    private stateDataBase: { [key: string]: LibraryStateVal } = {};
    private language: ioBroker.Languages | 'uk' = 'en';
    private forbiddenDirs: string[] = [];
    private translation: { [key: string]: string } = {};
    defaults = {
        updateStateOnChangeOnly: true,
    };
    constructor(adapter: AdapterClassDefinition, _options: any = null) {
        super(adapter, 'library');
        this.stateDataBase = {};
    }

    async init(): Promise<void> {
        const obj = await this.adapter.getForeignObjectAsync('system.config');
        if (obj) {
            await this.setLanguage(obj.common.language, true);
        } else {
            await this.setLanguage('en', true);
        }
    }

    /**
     * Write/create from a Json with defined keys, the associated states and channels
     *
     * @param prefix iobroker datapoint prefix where to write
     * @param objNode Entry point into the definition json.
     * @param def the definition json
     * @param data The Json to read
     * @param expandTree expand arrays up to 99
     * @returns  void
     */
    async writeFromJson(
        // provider.dwd.*warncellid*.warnung*1-5*
        prefix: string,
        objNode: string, // the json path to object def for jsonata
        def: statesObjectsType,
        data: any,
        expandTree: boolean = false,
    ): Promise<void> {
        if (!def || typeof def !== 'object') {
            return;
        }
        if (data === undefined || ['string', 'number', 'boolean', 'object'].indexOf(typeof data) == -1) {
            return;
        }

        const objectDefinition = objNode ? await this.getObjectDefFromJson(`${objNode}`, def, data) : null;

        if (objectDefinition) {
            objectDefinition.native = {
                ...(objectDefinition.native || {}),
                objectDefinitionReference: objNode,
            };
        }

        if (typeof data === 'object' && data !== null) {
            // handle array
            if (Array.isArray(data)) {
                if (!objectDefinition) {
                    return;
                }
                if (objectDefinition.type !== 'state' || expandTree) {
                    let a = 0;
                    for (const k in data) {
                        const defChannel = this.getChannelObject(objectDefinition);

                        const dp = `${prefix}${`00${a++}`.slice(-2)}`;
                        // create folder
                        await this.writedp(dp, null, defChannel);

                        await this.writeFromJson(dp, `${objNode}`, def, data[k], expandTree);
                    }
                } else {
                    this.writeFromJson(prefix, objNode, def, JSON.stringify(data) || '[]', expandTree).catch(() => {});
                }
                //objectDefinition._id = `${this.adapter.name}.${this.adapter.instance}.${prefix}.${key}`;
            } else {
                // create folder
                if (objectDefinition) {
                    const defChannel = this.getChannelObject(objectDefinition);
                    await this.writedp(prefix, null, defChannel);
                }
                if (data === null) {
                    return;
                }

                for (const k in data) {
                    await this.writeFromJson(`${prefix}.${k}`, `${objNode}.${k}`, def, data[k], expandTree);
                }
            }
        } else {
            if (!objectDefinition) {
                return;
            }
            await this.writedp(prefix, data, objectDefinition);
        }
    }

    /**
     * Get the ioBroker.Object out of stateDefinition
     *
     * @param key is the deep linking key to the definition
     * @param def
     * @param data  is the definition dataset
     * @returns ioBroker.ChannelObject | ioBroker.DeviceObject | ioBroker.StateObject
     */
    // eslint-disable-next-line
    async getObjectDefFromJson(key: string, def: any, data: any): Promise<ioBroker.Object> {
        //let result = await jsonata(`${key}`).evaluate(data);
        let result = this.deepJsonValue(key, def);
        if (result === null || result === undefined) {
            const k = key.split('.');
            if (k && k[k.length - 1].startsWith('_')) {
                result = genericStateObjects.customString;
                result = this.cloneObject(result);
            } else {
                this.log.debug(`No definition for ${key}!`);
                result = genericStateObjects.default;
                result = this.cloneObject(result);
                switch (typeof data) {
                    case 'number':
                    case 'bigint':
                        {
                            result.common.type = 'number';
                            result.common.role = 'value';
                        }
                        break;
                    case 'boolean':
                        {
                            result.common.type = 'boolean';
                            result.common.role = 'indicator';
                        }
                        break;
                    case 'string':
                    case 'symbol':
                    case 'undefined':
                    case 'object':
                    case 'function':
                        {
                            result.common.type = 'string';
                            result.common.role = 'text';
                        }
                        break;
                }
            }
        } else {
            result = this.cloneObject(result);
        }
        return result;
    }

    deepJsonValue(key: string, data: any): any {
        if (!key || !data || typeof data !== 'object' || typeof key !== 'string') {
            throw new Error(`Error(222) data or key are missing/wrong type!`);
        }
        const k = key.split(`.`);
        let c = 0,
            s = data;
        while (c < k.length) {
            s = s[k[c++]];
            if (s === undefined) {
                return null;
            }
        }
        return s;
    }

    /**
     * Get a channel/device definition from property _channel out of a getObjectDefFromJson() result or a default definition.
     *
     * @param def the data coming from getObjectDefFromJson()
     * @param definition
     * @returns ioBroker.ChannelObject | ioBroker.DeviceObject or a default channel obj
     */
    getChannelObject(
        definition: (ioBroker.Object & { _channel?: ioBroker.Object }) | null = null,
    ): ioBroker.ChannelObject | ioBroker.DeviceObject {
        const def = (definition && definition._channel) || null;
        const result: ioBroker.ChannelObject | ioBroker.DeviceObject = {
            _id: def ? def._id : '',
            type: def && def.type != 'device' ? 'channel' : 'device',
            common: {
                name: (def && def.common && def.common.name) || 'no definition',
            },
            native: (def && def.native) || {},
        };
        return result;
    }

    /**
     * Write/Create the specified data point with value, will only be written if val != oldval and obj.type == state or the data point value in the DB is not undefined. Channel and Devices have an undefined value.
     *
     * @param dp Data point to be written. Library.clean() is called with it.
     * @param val Value for this data point. Channel vals (old and new) are undefined so they never will be written.
     * @param obj The object definition for this data point (ioBroker.ChannelObject | ioBroker.DeviceObject | ioBroker.StateObject)
     * @param ack set ack to false if needed - NEVER after u subscript to states)
     * @returns void
     */
    async writedp(
        dp: string,
        val: ioBroker.StateValue | undefined,
        obj: ioBroker.Object | null = null,
        ack: boolean = true,
    ): Promise<void> {
        dp = this.cleandp(dp);
        let node = this.readdb(dp);
        const del = !this.isDirAllowed(dp);

        if (node === undefined) {
            if (!obj) {
                throw new Error('writedp try to create a state without object informations.');
            }
            obj._id = `${this.adapter.name}.${this.adapter.instance}.${dp}`;
            if (typeof obj.common.name == 'string') {
                obj.common.name = await this.getTranslationObj(obj.common.name);
            }
            if (typeof obj.common.desc == 'string') {
                obj.common.desc = await this.getTranslationObj(obj.common.desc);
            }
            if (!del) {
                await this.adapter.extendObject(dp, obj);
            }
            const stateType = obj && obj.common && obj.common.type;
            node = this.setdb(dp, obj.type, undefined, stateType, true, Date.now(), obj);
        } else if (node.init && obj) {
            if (typeof obj.common.name == 'string') {
                obj.common.name = await this.getTranslationObj(obj.common.name);
            }
            if (typeof obj.common.desc == 'string') {
                obj.common.desc = await this.getTranslationObj(obj.common.desc);
            }
            if (!del) {
                await this.adapter.extendObject(dp, obj);
            }
        }

        if (obj && obj.type !== 'state') {
            return;
        }

        if (node) {
            this.setdb(dp, node.type, val, node.stateTyp, true);
        }

        if (node && (this.defaults.updateStateOnChangeOnly || node.val != val || !node.ack)) {
            const typ = (obj && obj.common && obj.common.type) || node.stateTyp;
            if (typ && typ != typeof val && val !== undefined) {
                val = this.convertToType(val, typ);
            }
            if (!del) {
                await this.adapter.setState(dp, {
                    val: val,
                    ts: Date.now(),
                    ack: ack,
                });
            }
        }
    }

    setForbiddenDirs(dirs: any[]): void {
        this.forbiddenDirs = this.forbiddenDirs.concat(dirs);
    }

    isDirAllowed(dp: string): boolean {
        if (dp && dp.split('.').length <= 2) {
            return true;
        }
        for (const a in this.forbiddenDirs) {
            if (dp.search(new RegExp(this.forbiddenDirs[a], 'g')) != -1) {
                return false;
            }
        }
        return true;
    }

    /**
     * Retrieves the states from the state database that match the given string pattern.
     *
     * @param str - The string pattern to search for within the state database keys.
     * @returns An object containing the matching states, where the keys are the state database keys
     *          and the values are the corresponding `LibraryStateVal` objects.
     */
    getStates(str: string): { [key: string]: LibraryStateVal } {
        const result: { [key: string]: LibraryStateVal } = {};
        for (const dp in this.stateDataBase) {
            if (dp.search(new RegExp(str, 'g')) != -1) {
                result[dp] = this.stateDataBase[dp];
            }
        }
        return result;
    }

    async cleanUpTree(hold: string[], filter: string[] | null, deep: number): Promise<void> {
        let del = [];
        for (const dp in this.stateDataBase) {
            if (filter && filter.filter(a => dp.startsWith(a) || a.startsWith(dp)).length == 0) {
                continue;
            }
            if (hold.filter(a => dp.startsWith(a) || a.startsWith(dp)).length > 0) {
                continue;
            }
            delete this.stateDataBase[dp];
            del.push(dp.split('.').slice(0, deep).join('.'));
        }
        del = del.filter((item, pos, arr) => {
            return arr.indexOf(item) == pos;
        });
        for (const a in del) {
            await this.adapter.delObjectAsync(del[a], { recursive: true });
            this.log.debug(`Clean up tree delete: ${del[a]}`);
        }
    }

    /**
     * Remove forbidden chars from datapoint string.
     *
     * @param string Datapoint string to clean
     * @param lowerCase lowerCase() first param.
     * @param removePoints remove . from dp
     * @returns void
     */
    cleandp(string: string, lowerCase: boolean = false, removePoints: boolean = false): string {
        if (!string && typeof string != 'string') {
            return string;
        }

        string = string.replace(this.adapter.FORBIDDEN_CHARS, '_');
        // hardliner
        if (removePoints) {
            string = string.replace(/[^0-9A-Za-z_-]/gu, '_');
        } else {
            string = string.replace(/[^0-9A-Za-z._-]/gu, '_');
        }
        return lowerCase ? string.toLowerCase() : string;
    }

    /* Convert a value to the given type
     * @param {string|boolean|number} value 	then value to convert
     * @param {string}   type  					the target type
     * @returns
     */
    convertToType(value: ioBroker.StateValue | Array<any> | JSON, type: string): ioBroker.StateValue {
        if (value === null) {
            return null;
        }
        if (type === undefined) {
            throw new Error('convertToType type undefined not allowed!');
        }
        if (value === undefined) {
            value = '';
        }

        const old_type = typeof value;
        let newValue: ioBroker.StateValue = typeof value == 'object' ? JSON.stringify(value) : value;

        if (type !== old_type) {
            switch (type) {
                case 'string':
                    newValue = (value as string).toString() || '';
                    break;
                case 'number':
                    newValue = value ? parseFloat(value as string) : 0;
                    break;
                case 'boolean':
                    newValue = !!value;
                    break;
                case 'array':
                case 'json':
                    //JSON.stringify() is done before
                    break;
            }
        }
        return newValue;
    }

    readdb(dp: string): LibraryStateVal {
        return this.stateDataBase[this.cleandp(dp)];
    }

    setdb(
        dp: string,
        type: ioBroker.ObjectType | LibraryStateVal,
        val: ioBroker.StateValue | undefined = undefined,
        stateType: string | undefined = undefined,
        ack: boolean = true,
        ts: number = Date.now(),
        obj: ioBroker.Object | undefined = undefined,
        init: boolean = false,
    ): LibraryStateVal {
        if (typeof type == 'object') {
            type = type as LibraryStateVal;
            this.stateDataBase[dp] = type;
        } else {
            type = type as ioBroker.ObjectType;
            this.stateDataBase[dp] = {
                type: type,
                stateTyp:
                    stateType !== undefined
                        ? stateType
                        : this.stateDataBase[dp] !== undefined && this.stateDataBase[dp].stateTyp !== undefined
                          ? this.stateDataBase[dp].stateTyp
                          : undefined,
                val: val,
                ack: ack,
                ts: ts ? ts : Date.now(),
                obj:
                    obj !== undefined
                        ? obj
                        : this.stateDataBase[dp] !== undefined && this.stateDataBase[dp].obj !== undefined
                          ? this.stateDataBase[dp].obj
                          : undefined,
                init: init,
            };
        }
        return this.stateDataBase[dp];
    }

    async memberDeleteAsync(data: any[]): Promise<void> {
        for (const d of data) {
            await d.delete();
        }
    }

    cloneObject(obj: ioBroker.Object): ioBroker.Object {
        if (typeof obj !== 'object') {
            this.log.error(`Error clone object target is type: ${typeof obj}`);
            return obj;
        }
        return JSON.parse(JSON.stringify(obj));
    }

    cloneGenericObject(obj: object): object {
        if (typeof obj !== 'object') {
            this.log.error(`Error clone object target is type: ${typeof obj}`);
            return obj;
        }
        return JSON.parse(JSON.stringify(obj));
    }

    fileExistAsync(file: string): boolean {
        if (_fs.existsSync(`./admin/${file}`)) {
            return true;
        }
        return false;
    }

    /**
     * Initialise the database with the states to prevent unnecessary creation and writing.
     *
     * @param states States that are to be read into the database during initialisation.
     * @returns void
     */
    async initStates(states: { [key: string]: { val: ioBroker.StateValue; ts: number; ack: boolean } }): Promise<void> {
        if (!states) {
            return;
        }
        this.stateDataBase = {};
        const removedChannels: string[] = [];
        for (const state in states) {
            const dp = state.replace(`${this.adapter.name}.${this.adapter.instance}.`, '');
            const del = !this.isDirAllowed(dp);
            if (!del) {
                const obj = await this.adapter.getObjectAsync(dp);
                this.setdb(
                    dp,
                    'state',
                    states[state] && states[state].val ? states[state].val : undefined,
                    obj && obj.common && obj.common.type ? obj.common.type : undefined,
                    states[state] && states[state].ack,
                    states[state] && states[state].ts ? states[state].ts : Date.now(),
                    obj == null ? undefined : obj,
                    true,
                );
            } else {
                if (!removedChannels.every(a => !dp.startsWith(a))) {
                    continue;
                }
                const channel = dp.split('.').slice(0, 4).join('.');
                removedChannels.push(channel);
                await this.adapter.delObjectAsync(channel, { recursive: true });
                this.log.debug(`Delete channel with dp:${channel}`);
            }
        }
    }

    /**
     * Resets states that have not been updated in the database in offset time.
     *
     * @param prefix String with which states begin that are reset.
     * @param offset Time in ms since last update.
     * @param del
     * @returns void
     */
    async garbageColleting(prefix: string, offset: number = 2000, del = false): Promise<void> {
        if (!prefix) {
            return;
        }
        if (this.stateDataBase) {
            for (const id in this.stateDataBase) {
                if (id.startsWith(prefix)) {
                    const state = this.stateDataBase[id];
                    if (
                        !state ||
                        state.val == undefined ||
                        (state.obj && state.obj.native && state.obj.native.noReset)
                    ) {
                        continue;
                    }
                    if (state.ts < Date.now() - offset) {
                        if (del) {
                            await this.cleanUpTree([], [id], -1);
                            continue;
                        }
                        let value: any;
                        if (state.obj && state.obj.common && state.obj.common.def !== undefined) {
                            value = state.obj.common.def;
                        } else {
                            let newVal: -1 | '' | '{}' | '[]' | false | null | undefined;
                            switch (state.stateTyp) {
                                case 'string':
                                    if (typeof state.val == 'string') {
                                        if (state.val.startsWith('{') && state.val.endsWith('}')) {
                                            newVal = '{}';
                                        } else if (state.val.startsWith('[') && state.val.endsWith(']')) {
                                            newVal = '[]';
                                        } else {
                                            newVal = '';
                                        }
                                    } else {
                                        newVal = '';
                                    }
                                    break;
                                case 'bigint':
                                case 'number':
                                    newVal = -1;
                                    break;

                                case 'boolean':
                                    newVal = false;
                                    break;
                                case 'symbol':
                                case 'object':
                                case 'function':
                                    newVal = null;
                                    break;
                                case 'undefined':
                                    newVal = undefined;
                                    break;
                            }
                            value = newVal;
                        }
                        await this.writedp(id, value);
                    }
                }
            }
        }
    }

    getLocalLanguage(): string {
        if (this.language) {
            return this.language;
        }
        return 'en-En';
    }
    getTranslation(key: string): string {
        if (this.translation[key] !== undefined) {
            return this.translation[key];
        }
        return key;
    }
    existTranslation(key: string): boolean {
        return this.translation[key] !== undefined;
    }

    async getTranslationObj(key: string): Promise<ioBroker.StringOrTranslated> {
        const language: (ioBroker.Languages | 'uk')[] = [
            'en',
            'de',
            'ru',
            'pt',
            'nl',
            'fr',
            'it',
            'es',
            'pl',
            'uk',
            'zh-cn',
        ];
        const result: { [key: string]: string } = {};
        for (const l of language) {
            try {
                const i = await import(`../../admin/i18n/${l}/translations.json`);
                if (i[key] !== undefined) {
                    result[l as string] = i[key];
                }
            } catch {
                return key;
            }
        }
        if (result.en == undefined) {
            return key;
        }
        return result as ioBroker.StringOrTranslated;
    }

    async setLanguage(language: ioBroker.Languages | 'uk', force = false): Promise<boolean> {
        if (!language) {
            language = 'en';
        }
        if (force || this.language != language) {
            try {
                this.translation = await import(`../../admin/i18n/${language}/translations.json`);
                this.language = language;
                return true;
            } catch {
                this.log.error(`Language ${language} not exist!`);
            }
        }
        return false;
    }
    sortText(text: string[]): string[] {
        text.sort((a, b) => {
            const nameA = a.toUpperCase(); // ignore upper and lowercase
            const nameB = b.toUpperCase(); // ignore upper and lowercase
            if (nameA < nameB) {
                return -1;
            }
            if (nameA > nameB) {
                return 1;
            }

            return 0;
        });
        return text;
    }
    /**
     *
     * @param text string to replace a Date
     * @param noti appendix to translation key
     * @param day true = Mo, 12.05 - false = 12.05
     * @returns Monday first March
     */
    convertSpeakDate(text: string, noti: string = '', day = false): string {
        if (!text || typeof text !== `string`) {
            return ``;
        }
        const b = text.split(`.`);
        if (day) {
            b[0] = b[0].split(' ')[2];
        }
        return ` ${`${new Date(`${b[1]}/${b[0]}/${new Date().getFullYear()}`).toLocaleString(this.language, {
            weekday: day ? 'long' : undefined,
            day: 'numeric',
            month: `long`,
        })} `.replace(/([0-9]+\.)/gu, x => {
            const result = this.getTranslation(x + noti);
            if (result != x + noti) {
                return result;
            }
            return this.getTranslation(x);
        })}`;
    }
}
export async function sleep(time: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, time));
}
