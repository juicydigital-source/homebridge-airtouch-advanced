import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { EventEmitter } from 'events';

import { AirtouchAPI, type AcAbility, type AcStatus, type ZoneStatus } from './airtouch/api.js';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';

export class AirTouchAdvancedPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly emitter = new EventEmitter();
  private airtouch?: AirtouchAPI;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('AirTouch Advanced initialised');

    this.emitter.on('ac_ability', (ability: AcAbility) => {
      this.log.info(
        'READ | AC %d "%s" | zones %d-%d | modes auto:%d heat:%d cool:%d fan:%d dry:%d | fan auto:%d low:%d med:%d high:%d',
        ability.ac_unit_number,
        ability.ac_name,
        ability.ac_start_zone,
        ability.ac_start_zone + ability.ac_zone_count - 1,
        ability.ac_support_auto_mode,
        ability.ac_support_heat_mode,
        ability.ac_support_cool_mode,
        ability.ac_support_fan_mode,
        ability.ac_support_dry_mode,
        ability.ac_support_fan_auto,
        ability.ac_support_fan_low,
        ability.ac_support_fan_medium,
        ability.ac_support_fan_high,
      );
    });

    this.emitter.on('ac_status', (status: AcStatus) => {
      const modes: Record<number, string> = { 0: 'Auto', 1: 'Heat', 2: 'Dry', 3: 'Fan', 4: 'Cool' };
      const fans: Record<number, string> = {
        0: 'Auto', 1: 'Quiet', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Powerful', 6: 'Turbo', 8: 'Intelligent',
      };
      this.log.info(
        'READ | AC %d | power:%s mode:%s fan:%s target:%sC temp:%sC error:%d',
        status.ac_unit_number,
        status.ac_power_state ? 'On' : 'Off',
        modes[status.ac_mode] ?? status.ac_mode,
        fans[status.ac_fan_speed] ?? status.ac_fan_speed,
        status.ac_target,
        status.ac_temp,
        status.ac_error_code,
      );
    });

    this.emitter.on('zone_status', (status: ZoneStatus) => {
      this.log.info(
        'READ | Zone %d | power:%s damper:%d%% control:%s target:%sC temp:%sC sensor:%s',
        status.zone_number,
        status.zone_power_state ? 'On' : 'Off',
        status.zone_damper_position,
        status.zone_control_type === 1 ? 'Temperature' : 'Percentage',
        status.zone_target,
        status.zone_temp,
        status.zone_has_sensor ? 'Yes' : 'No',
      );
    });

    this.emitter.on('zone_name', (zoneNumber: number, zoneName: string) => {
      this.log.info('READ | Zone %d name: "%s"', zoneNumber, zoneName);
    });

    this.emitter.on('attempt_reconnect', () => {
      this.log.warn('AirTouch connection dropped; attempting to reconnect.');
      setTimeout(() => this.airtouch?.connect(), 3000);
    });

    if (this.config.host) {
      this.log.info('AirTouch controller configured at %s', this.config.host);
    } else {
      this.log.warn('No AirTouch host configured yet. Open plugin settings and enter the controller IP address.');
    }

    this.api.on('didFinishLaunching', () => {
      const host = typeof this.config.host === 'string' ? this.config.host.trim() : '';
      if (!host) {
        return;
      }

      this.log.info('Starting read-only AirTouch 5 connection to %s:9005', host);
      this.airtouch = new AirtouchAPI(host, 'manual', 'manual', 'AirTouch 5', this.log, this.emitter);
      this.airtouch.connect();
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
