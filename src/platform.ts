import type {
  API,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { EventEmitter } from 'events';

import {
  AirtouchAPI,
  type AcAbility,
  type AcStatus,
  type ZoneStatus,
} from './airtouch/api.js';
import { MAGIC } from './airtouch/magic.js';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';

type AirTouchAccessoryContext = {
  kind?: 'system' | 'zone' | 'ac' | 'fan' | 'vent';
  acNumber?: number;
  zoneNumber?: number;
};

export class AirTouchAdvancedPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory<AirTouchAccessoryContext>[] = [];

  private readonly emitter = new EventEmitter();
  private airtouch?: AirtouchAPI;
  private acAbility?: AcAbility;
  private acStatus?: AcStatus;
  private readonly zoneStatuses = new Map<number, ZoneStatus>();
  private readonly zoneNames = new Map<number, string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('AirTouch Advanced initialised');

    this.emitter.on('ac_ability', (ability: AcAbility) => {
      this.acAbility = ability;
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
      this.ensureSystemAccessory();
    });

    this.emitter.on('ac_status', (status: AcStatus) => {
      this.acStatus = status;
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
      this.ensureSystemAccessory();
      this.updateSystemAccessory();
    });

    this.emitter.on('zone_status', (status: ZoneStatus) => {
      this.zoneStatuses.set(status.zone_number, status);
      this.log.info(
        'READ | Zone %d | power:%s damper:%d%% temp:%sC',
        status.zone_number,
        status.zone_power_state ? 'On' : 'Off',
        status.zone_damper_position,
        status.zone_temp,
      );
      this.ensureZoneAccessory(status.zone_number);
      this.updateZoneAccessory(status.zone_number);
    });

    this.emitter.on('zone_name', (zoneNumber: number, zoneName: string) => {
      this.zoneNames.set(zoneNumber, zoneName);
      this.log.info('READ | Zone %d name: "%s"', zoneNumber, zoneName);
      this.ensureZoneAccessory(zoneNumber);
      this.updateZoneAccessory(zoneNumber);
    });

    this.emitter.on('attempt_reconnect', () => {
      this.log.warn('AirTouch connection dropped; attempting to reconnect.');
      setTimeout(() => this.airtouch?.connect(), 3000);
    });

    if (this.config.host) {
      this.log.info('AirTouch controller configured at %s', this.config.host);
    } else {
      this.log.warn('No AirTouch host configured.');
    }

    this.api.on('didFinishLaunching', () => {
      this.cleanupLegacyAccessories();

      const host = typeof this.config.host === 'string' ? this.config.host.trim() : '';
      if (!host) {
        return;
      }

      this.log.info('Connecting to AirTouch 5 at %s:9005', host);
      this.airtouch = new AirtouchAPI(host, 'manual', 'manual', 'AirTouch 5', this.log, this.emitter);
      this.airtouch.connect();
    });
  }

  configureAccessory(accessory: PlatformAccessory<AirTouchAccessoryContext>) {
    this.log.info('Restoring cached accessory: %s', accessory.displayName);
    this.accessories.push(accessory);
  }

  private cleanupLegacyAccessories() {
    const legacy = this.accessories.filter((accessory) =>
      accessory.context.kind === 'ac'
      || accessory.context.kind === 'fan'
      || accessory.context.kind === 'vent',
    );

    if (legacy.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, legacy);
      for (const item of legacy) {
        const i = this.accessories.indexOf(item);
        if (i >= 0) this.accessories.splice(i, 1);
      }
      this.log.info('Removed %d legacy AirTouch accessories.', legacy.length);
    }

    for (const accessory of this.accessories.filter((item) => item.context.kind === 'zone')) {
      const thermostat = accessory.getService(this.Service.Thermostat);
      if (thermostat) accessory.removeService(thermostat);
    }
  }

  private getOrCreateAccessory(
    displayName: string,
    key: string,
    context: AirTouchAccessoryContext,
  ): PlatformAccessory<AirTouchAccessoryContext> {
    const uuid = this.api.hap.uuid.generate(`airtouch-advanced-${key}`);
    let accessory = this.accessories.find((item) => item.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory<AirTouchAccessoryContext>(displayName, uuid);
      accessory.context = context;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info('Created accessory: %s', displayName);
    } else {
      accessory.context = { ...accessory.context, ...context };
    }

    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(this.Characteristic.Model, 'AirTouch 5')
      .setCharacteristic(this.Characteristic.SerialNumber, `AirTouch-${key}`);

    return accessory;
  }

  private ensureSystemAccessory() {
    if (!this.acAbility && !this.acStatus) return;

    const acNumber = this.acStatus?.ac_unit_number ?? this.acAbility?.ac_unit_number ?? 0;
    const accessory = this.getOrCreateAccessory(
      'AirTouch System',
      `system-${acNumber}`,
      { kind: 'system', acNumber },
    );

    let thermostat = accessory.getService(this.Service.Thermostat);
    if (!thermostat) {
      thermostat = accessory.addService(this.Service.Thermostat, 'AirTouch System');
      thermostat.setCharacteristic(
        this.Characteristic.TemperatureDisplayUnits,
        this.Characteristic.TemperatureDisplayUnits.CELSIUS,
      );

      thermostat.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
        .onGet(() => this.getSystemTargetMode())
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.acSetTargetHeatingCoolingState(acNumber, Number(value));
        });

      thermostat.getCharacteristic(this.Characteristic.TargetTemperature)
        .onGet(() => this.acStatus?.ac_target ?? 20)
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.acSetTargetTemperature(acNumber, Number(value));
        });

      thermostat.getCharacteristic(this.Characteristic.CurrentTemperature)
        .onGet(() => this.acStatus?.ac_temp ?? 20);

      thermostat.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
        .onGet(() => this.getSystemCurrentMode());
    }

    const speeds: Array<[number, string]> = [];
    if (this.acAbility?.ac_support_fan_auto) speeds.push([MAGIC.AC_FAN_SPEEDS.AUTO, 'Auto']);
    if (this.acAbility?.ac_support_fan_low) speeds.push([MAGIC.AC_FAN_SPEEDS.LOW, 'Low']);
    if (this.acAbility?.ac_support_fan_medium) speeds.push([MAGIC.AC_FAN_SPEEDS.MEDIUM, 'Medium']);
    if (this.acAbility?.ac_support_fan_high) speeds.push([MAGIC.AC_FAN_SPEEDS.HIGH, 'High']);

    for (const [speed, label] of speeds) {
      let service = accessory.getServiceById(this.Service.Switch, `fan-${speed}`);
      if (!service) {
        service = accessory.addService(this.Service.Switch, `Fan ${label}`, `fan-${speed}`);
        service.getCharacteristic(this.Characteristic.On)
          .onGet(() => this.acStatus?.ac_fan_speed === speed)
          .onSet((value: CharacteristicValue) => {
            if (Boolean(value)) {
              this.airtouch?.acSetFanSpeed(acNumber, speed);
            }
          });
      }
    }
  }

  private ensureZoneAccessory(zoneNumber: number) {
    const status = this.zoneStatuses.get(zoneNumber);
    const name = this.zoneNames.get(zoneNumber);
    if (!status || !name) return;

    const accessory = this.getOrCreateAccessory(
      name,
      `zone-${zoneNumber}`,
      { kind: 'zone', zoneNumber },
    );

    const oldThermostat = accessory.getService(this.Service.Thermostat);
    if (oldThermostat) accessory.removeService(oldThermostat);

    let switchService = accessory.getService(this.Service.Switch);
    if (!switchService) {
      switchService = accessory.addService(this.Service.Switch, `${name} On/Off`);
      switchService.getCharacteristic(this.Characteristic.On)
        .onGet(() => Boolean(this.zoneStatuses.get(zoneNumber)?.zone_power_state))
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.zoneSetActive(zoneNumber, Boolean(value));
        });
    }

    let temperatureService = accessory.getServiceById(this.Service.TemperatureSensor, 'temperature');
    if (!temperatureService) {
      temperatureService = accessory.addService(
        this.Service.TemperatureSensor,
        `${name} Temperature`,
        'temperature',
      );
      temperatureService.getCharacteristic(this.Characteristic.CurrentTemperature)
        .onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_temp ?? 20);
    }

    let vent = accessory.getServiceById(this.Service.WindowCovering, 'vent');
    if (!vent) {
      vent = accessory.addService(this.Service.WindowCovering, `${name} Vent`, 'vent');

      vent.getCharacteristic(this.Characteristic.CurrentPosition)
        .onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_damper_position ?? 0);

      vent.getCharacteristic(this.Characteristic.TargetPosition)
        .onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_damper_position ?? 0)
        .onSet((value: CharacteristicValue) => {
          const rounded = Math.max(0, Math.min(100, Math.round(Number(value) / 5) * 5));
          this.airtouch?.zoneSetPercentage(zoneNumber, rounded);
        });

      vent.getCharacteristic(this.Characteristic.PositionState)
        .onGet(() => this.Characteristic.PositionState.STOPPED);
    }
  }

  private updateSystemAccessory() {
    if (!this.acStatus) return;

    const accessory = this.accessories.find((item) =>
      item.context.kind === 'system' && item.context.acNumber === this.acStatus!.ac_unit_number,
    );

    const thermostat = accessory?.getService(this.Service.Thermostat);
    thermostat?.updateCharacteristic(this.Characteristic.CurrentTemperature, this.acStatus.ac_temp);
    thermostat?.updateCharacteristic(this.Characteristic.TargetTemperature, this.acStatus.ac_target);
    thermostat?.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.getSystemCurrentMode());
    thermostat?.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.getSystemTargetMode());

    for (const speed of [
      MAGIC.AC_FAN_SPEEDS.AUTO,
      MAGIC.AC_FAN_SPEEDS.LOW,
      MAGIC.AC_FAN_SPEEDS.MEDIUM,
      MAGIC.AC_FAN_SPEEDS.HIGH,
    ]) {
      accessory?.getServiceById(this.Service.Switch, `fan-${speed}`)
        ?.updateCharacteristic(this.Characteristic.On, this.acStatus.ac_fan_speed === speed);
    }
  }

  private updateZoneAccessory(zoneNumber: number) {
    const status = this.zoneStatuses.get(zoneNumber);
    if (!status) return;

    const accessory = this.accessories.find((item) =>
      item.context.kind === 'zone' && item.context.zoneNumber === zoneNumber,
    );

    accessory?.getService(this.Service.Switch)
      ?.updateCharacteristic(this.Characteristic.On, Boolean(status.zone_power_state));

    accessory?.getServiceById(this.Service.TemperatureSensor, 'temperature')
      ?.updateCharacteristic(this.Characteristic.CurrentTemperature, status.zone_temp);

    const vent = accessory?.getServiceById(this.Service.WindowCovering, 'vent');
    vent?.updateCharacteristic(this.Characteristic.CurrentPosition, status.zone_damper_position);
    vent?.updateCharacteristic(this.Characteristic.TargetPosition, status.zone_damper_position);
    vent?.updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
  }

  private getSystemTargetMode(): number {
    if (!this.acStatus?.ac_power_state) {
      return this.Characteristic.TargetHeatingCoolingState.OFF;
    }
    if (this.acStatus.ac_mode === MAGIC.AC_MODES.HEAT) {
      return this.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (this.acStatus.ac_mode === MAGIC.AC_MODES.COOL) {
      return this.Characteristic.TargetHeatingCoolingState.COOL;
    }
    return this.Characteristic.TargetHeatingCoolingState.AUTO;
  }

  private getSystemCurrentMode(): number {
    if (!this.acStatus?.ac_power_state) {
      return this.Characteristic.CurrentHeatingCoolingState.OFF;
    }
    if (this.acStatus.ac_mode === MAGIC.AC_MODES.HEAT) {
      return this.Characteristic.CurrentHeatingCoolingState.HEAT;
    }
    if (this.acStatus.ac_mode === MAGIC.AC_MODES.COOL) {
      return this.Characteristic.CurrentHeatingCoolingState.COOL;
    }
    return this.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  removeAccessory(accessory: PlatformAccessory<AirTouchAccessoryContext>) {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }
}
