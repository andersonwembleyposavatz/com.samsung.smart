'use strict';

const Homey = require('homey');
const BaseDevice = require('../../lib/BaseDevice');
const Samsung = require('./Samsung');
const ip = require('ip');

module.exports = class SamsungDevice extends BaseDevice {

    async onInit() {
        super.onInit('Samsung');

        let settings = await this.getSettings();
        if (settings.tokenAuthSupport === undefined || settings.tokenAuthSupport === null) {
            this.setSettings({"tokenAuthSupport": false});
            settings.tokenAuthSupport = false;
        }
        this._samsung = new Samsung({
            device: this,
            name: "homey",
            ip_address: settings.ipaddress,
            mac_address: settings.mac_address,
            port: 8001,
            api_timeout: 2000,
            delay_keys: settings.delay_keys || 100,
            delay_channel_keys: settings.delay_channel_keys || 1250,
            ip_address_homey: ip.address(),
            tokenAuthSupport: settings.tokenAuthSupport,
            frameTVSupport: settings.frameTVSupport,
            token: settings.token,
            logger: this.logger
        });

        this._pairRetries = 3;
        this._lastAppsRefresh = undefined;
        this.initSmartThings();
        this.pairDevice();
    }

    onSettings(oldSettingsObj, newSettingsObj, changedKeysArr, callback) {
        if (changedKeysArr.includes('ipaddress')) {
            this.updateIPAddress(newSettingsObj.ipaddress);
            this._lastAppsRefresh = undefined; // Force app list refresh
        }
        if (changedKeysArr.includes('poll_interval')) {
            this.addPollDevice(newSettingsObj.poll_interval);
        }
        if (changedKeysArr.includes('delay_keys')) {
            this._samsung.config()["delay_keys"] = newSettingsObj.delay_keys;
        }
        if (changedKeysArr.includes('delay_channel_keys')) {
            this._samsung.config()["delay_channel_keys"] = newSettingsObj.delay_channel_keys;
        }
        if (changedKeysArr.includes('tokenAuthSupport')) {
            this._samsung.config()["tokenAuthSupport"] = newSettingsObj.tokenAuthSupport;
            if (newSettingsObj.tokenAuthSupport) {
                // Will pair if tokenAuthSupport is set to TRUE
                this._pairRetries = 3;
                this.pairDevice();
            } else {
                // Clear token
                this._samsung.config()["token"] = undefined;
                setTimeout(() => {
                    this.setSettings({ "token": undefined });
                }, 1000);
            }
        }
        if (changedKeysArr.includes('frameTVSupport')) {
            this._samsung.config()["frameTVSupport"] = newSettingsObj.frameTVSupport;
        }
        if (changedKeysArr.includes('smartthings') || changedKeysArr.includes('smartthings_token')) {
            this.initSmartThings();
        }
        callback(null, true);
    }

    async isSmartThingsEnabled() {
        let settings = await this.getSettings();
        return settings.smartthings && settings.smartthings_token && settings.smartthings_token.length > 0;
    }

    async initSmartThings() {
        setTimeout(async () => {
            this._samsung.clearStClient();
            const stEnabled = await this.isSmartThingsEnabled();
            if (stEnabled) {
                try {
                    await this._samsung.getStInputSources();
                } catch (err) {
                    this.logger.info('Fetching ST input sources failed', err);
                }
            }
        }, 2000);
    }

    async checkIPAddress(ipaddress) {
        let info = await this._samsung.getInfo(ipaddress)
            .catch(err => {
                this.logger.info('TV set unavailable');
                this.setUnavailable(Homey.__('errors.unavailable.not_found'));
            });
        if (info) {
            this.logger.info('TV set available');
            this.setAvailable();
        }
    }

    async pollDevice() {
        if (this._is_powering_onoff !== undefined) {
            return;
        }
        let onOff;
        const stEnabled = await this.isSmartThingsEnabled();
        if (stEnabled) {
            onOff = await this._samsung.getStHealth();
        }
        if (!stEnabled || (onOff !== false && onOff !== true)) {
            onOff = await this._samsung.apiActive();
        }

        if (onOff && this.getAvailable() === false) {
            this.setAvailable();
        }
        if (onOff !== this.getCapabilityValue('onoff')) {
            this.setCapabilityValue('onoff', onOff).catch(err => this.logger.error('Error setting onoff capability', err));
        }
        if (onOff) {
            this.logger.verbose('pollDevice: TV is on');
            await this.shouldFetchModelName();
            await this.shouldRefreshAppList();
        }
    }

    async pairDevice(delay = 5000) {
        let config = this._samsung.config();
        if (config.tokenAuthSupport !== true || config.token) {
            return;
        }

        await this._delay(delay);

        this.logger.info('Pairing started...');
        this._samsung.pair()
            .then(token => {
                this.logger.info(`pairDevice: got a new token: ${self._config.token}`);
                this.setSettings({"token": token});
            })
            .catch(error => {
                if (this._pairRetries > 1) {
                    this.pairDevice(1000);
                    this._pairRetries--;
                } else {
                    this.logger.info('pairDevice: failed', error);
                }
            });
    }

    async shouldFetchModelName() {
        if (!this.getSetting('modelName')) {
            let modelName = 'unknown';
            try {
                let data = await this._samsung.getInfo();
                this.logger.verbose('shouldFetchModelName', data.data);
                if (data && data.data) {
                    modelName = data.data.device.modelName;
                }
            } catch (err) {
                this.logger.info('Fetching modelName failed', err);
            } finally {
                await this.setSettings({ modelName: modelName });
                this.logger.setTags({ modelName });
                this.logger.info(`Modelname set to: ${modelName}`);
            }
        }
    }

    async refreshAppList() {
        try {
            await this._samsung.getListOfApps()
            this._lastAppsRefresh = new Date().getTime();
        } catch (err) {
            this.logger.info('refreshAppList ERROR', err);
        }
    }

    async shouldRefreshAppList() {
        let now = new Date().getTime();
        if (!this._lastAppsRefresh || (now - this._lastAppsRefresh) > 300000) {
            await this.refreshAppList();
        }
    }

    onAppAutocomplete(query, args) {
        let apps = this._samsung.getApps();
        return Promise.resolve((apps === undefined ? [] : apps).map(app => {
            return {
                id: app.appId,
                name: app.name
            };
        }).filter(result => {
            return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        }).sort((a, b) => {
            if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
            if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
            return 0;
        }));
    }

    async onInputSourceAutocomplete(query, args) {
        let inputSources = await this._samsung.getStInputSources();
        return Promise.resolve((inputSources === undefined ? [] : inputSources).map(is => {
            return {
                id: is,
                name: is
            };
        }).filter(result => {
            return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        }).sort((a, b) => {
            if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
            if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
            return 0;
        }));
    }
};
