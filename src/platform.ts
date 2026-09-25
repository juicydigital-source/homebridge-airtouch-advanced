import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';

export class AirTouchAdvancedPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('AirTouch Advanced initialised');
    if (this.config.host) {
      this.log.info('AirTouch controller configured at %s', this.config.host);
    } else {
      this.log.warn('No AirTouch host configured yet. Open plugin settings and enter the controller IP address.');
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info('AirTouch Advanced is ready. Device discovery and local protocol support will be added next.');
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Restoring cached accessory: %s', accessory.displayName);
    this.accessories.push(accessory);
  }

  removeAccessory(accessory: PlatformAccessory) {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }
}
