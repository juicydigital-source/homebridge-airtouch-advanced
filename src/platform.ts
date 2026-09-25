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
  kind?: 'system' | 'zone' | 'temperature' | 'ac' | 'fan' | 'vent';
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
      for (const service of [...accessory.services]) {
        if (
          service.UUID === this.Service.Switch.UUID
          || service.UUID === this.Service.TemperatureSensor.UUID
          || service.UUID === this.Service.Fanv2.UUID
          || service.UUID === this.Service.WindowCovering.UUID
          || service.UUID === this.Service.Thermostat.UUID
          || service.UUID === this.Service.HeaterCooler.UUID
        ) {
          accessory.removeService(service);
        }
      }
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
      .setCharacteristic(this.Characteristic.Name, displayName)
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
    }
    this.setServiceName(thermostat, 'AirTouch System');
    if (!thermostat.getCharacteristic(this.Characteristic.TargetHeatingCoolingState).listenerCount('set')) {
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

    // Remove the older individual fan-speed switches.
    for (const speed of [
      MAGIC.AC_FAN_SPEEDS.AUTO,
      MAGIC.AC_FAN_SPEEDS.QUIET,
      MAGIC.AC_FAN_SPEEDS.LOW,
      MAGIC.AC_FAN_SPEEDS.MEDIUM,
      MAGIC.AC_FAN_SPEEDS.HIGH,
      MAGIC.AC_FAN_SPEEDS.POWERFUL,
      MAGIC.AC_FAN_SPEEDS.TURBO,
      MAGIC.AC_FAN_SPEEDS.INTELLIGENT,
    ]) {
      const oldFanSwitch = accessory.getServiceById(this.Service.Switch, `fan-${speed}`);
      if (oldFanSwitch) {
        accessory.removeService(oldFanSwitch);
      }
    }

    let systemFan = accessory.getServiceById(this.Service.Fanv2, 'system-fan');
    if (!systemFan) {
      systemFan = accessory.addService(this.Service.Fanv2, 'System Fan', 'system-fan');
    }
    this.setServiceName(systemFan, 'System Fan');
    thermostat.addLinkedService(systemFan);

    const fanActive = systemFan.getCharacteristic(this.Characteristic.Active);
    if (!fanActive.listenerCount('get') && !fanActive.listenerCount('set')) {
      fanActive
        .onGet(() => this.acStatus?.ac_power_state
          ? this.Characteristic.Active.ACTIVE
          : this.Characteristic.Active.INACTIVE)
        .onSet((value: CharacteristicValue) => {
          const enabled = Number(value) === this.Characteristic.Active.ACTIVE;
          if (!enabled) {
            this.airtouch?.acSetTargetHeatingCoolingState(
              acNumber,
              this.Characteristic.TargetHeatingCoolingState.OFF,
            );
            return;
          }

          if (!this.acStatus?.ac_power_state) {
            this.airtouch?.acSetTargetHeatingCoolingState(
              acNumber,
              this.getTargetModeForAirTouchMode(this.acStatus?.ac_mode),
            );
          }
        });
    }

    const fanSpeed = systemFan.getCharacteristic(this.Characteristic.RotationSpeed);
    fanSpeed.setProps({ minValue: 0, maxValue: 100, minStep: 1 });
    if (!fanSpeed.listenerCount('get') && !fanSpeed.listenerCount('set')) {
      fanSpeed
        .onGet(() => this.getSystemFanPercentage())
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.acSetFanSpeed(acNumber, this.getAirTouchFanSpeedForPercentage(Number(value)));
        });
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

    // Google/HomeKit automation-friendly model:
    // Primary Fanv2 = room air vent (0-100%) + zone on/off
    // Secondary Switch = explicit zone on/off
    // Separate accessory = current room temperature
    for (const service of [...accessory.services]) {
      if (
        service.UUID === this.Service.HeaterCooler.UUID
        || service.UUID === this.Service.Thermostat.UUID
        || service.UUID === this.Service.WindowCovering.UUID
        || service.UUID === this.Service.TemperatureSensor.UUID
      ) {
        accessory.removeService(service);
      }
    }

    let damper = accessory.getServiceById(this.Service.Fanv2, 'damper');
    if (!damper) {
      damper = accessory.addService(this.Service.Fanv2, `${name} Air Vent`, 'damper');
    }
    this.setServiceName(damper, `${name} Air Vent`);
    damper.setPrimaryService();

    damper.addOptionalCharacteristic(this.Characteristic.CurrentTemperature);
    const roomTemperature = damper.getCharacteristic(this.Characteristic.CurrentTemperature);
    if (!roomTemperature.listenerCount('get')) {
      roomTemperature.onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_temp ?? 20);
    }

    const active = damper.getCharacteristic(this.Characteristic.Active);
    if (!active.listenerCount('get') && !active.listenerCount('set')) {
      active
        .onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_power_state
          ? this.Characteristic.Active.ACTIVE
          : this.Characteristic.Active.INACTIVE)
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.zoneSetActive(
            zoneNumber,
            Number(value) === this.Characteristic.Active.ACTIVE,
          );
        });
    }

    const percentage = damper.getCharacteristic(this.Characteristic.RotationSpeed);
    percentage.setProps({ minValue: 0, maxValue: 100, minStep: 5 });
    if (!percentage.listenerCount('get') && !percentage.listenerCount('set')) {
      percentage
        .onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_damper_position ?? 0)
        .onSet((value: CharacteristicValue) => {
          const rounded = Math.max(0, Math.min(100, Math.round(Number(value) / 5) * 5));
          this.airtouch?.zoneSetPercentage(zoneNumber, rounded);
        });
    }

    let zoneSwitch = accessory.getServiceById(this.Service.Switch, 'zone-power');
    if (!zoneSwitch) {
      zoneSwitch = accessory.addService(this.Service.Switch, `${name} On / Off`, 'zone-power');
    }
    this.setServiceName(zoneSwitch, `${name} On / Off`);
    damper.addLinkedService(zoneSwitch);

    const on = zoneSwitch.getCharacteristic(this.Characteristic.On);
    if (!on.listenerCount('get') && !on.listenerCount('set')) {
      on
        .onGet(() => Boolean(this.zoneStatuses.get(zoneNumber)?.zone_power_state))
        .onSet((value: CharacteristicValue) => {
          this.airtouch?.zoneSetActive(zoneNumber, Boolean(value));
        });
    }

    const temperatureAccessory = this.getOrCreateAccessory(
      `${name} Temperature`,
      `temperature-${zoneNumber}`,
      { kind: 'temperature', zoneNumber },
    );

    let temperature = temperatureAccessory.getService(this.Service.TemperatureSensor);
    if (!temperature) {
      temperature = temperatureAccessory.addService(
        this.Service.TemperatureSensor,
        `${name} Temperature`,
      );
    }
    this.setServiceName(temperature, `${name} Temperature`);
    temperature.setPrimaryService();

    const currentTemperature = temperature.getCharacteristic(this.Characteristic.CurrentTemperature);
    if (!currentTemperature.listenerCount('get')) {
      currentTemperature.onGet(() => this.zoneStatuses.get(zoneNumber)?.zone_temp ?? 20);
    }
  }

  private setServiceName(service: Service, name: string) {
    service.setCharacteristic(this.Characteristic.Name, name);
    service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    service.setCharacteristic(this.Characteristic.ConfiguredName, name);
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

    const systemFan = accessory?.getServiceById(this.Service.Fanv2, 'system-fan');
    systemFan?.updateCharacteristic(
      this.Characteristic.Active,
      this.acStatus.ac_power_state ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
    );
    systemFan?.updateCharacteristic(this.Characteristic.RotationSpeed, this.getSystemFanPercentage());
  }

  private updateZoneAccessory(zoneNumber: number) {
    const status = this.zoneStatuses.get(zoneNumber);
    if (!status) return;

    const accessory = this.accessories.find((item) =>
      item.context.kind === 'zone' && item.context.zoneNumber === zoneNumber,
    );

    accessory?.getServiceById(this.Service.Switch, 'zone-power')
      ?.updateCharacteristic(this.Characteristic.On, Boolean(status.zone_power_state));

    const damper = accessory?.getServiceById(this.Service.Fanv2, 'damper');
    damper?.updateCharacteristic(
      this.Characteristic.Active,
      status.zone_power_state ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
    );
    damper?.updateCharacteristic(this.Characteristic.RotationSpeed, status.zone_damper_position);
    damper?.updateCharacteristic(this.Characteristic.CurrentTemperature, status.zone_temp);

    const temperatureAccessory = this.accessories.find((item) =>
      item.context.kind === 'temperature' && item.context.zoneNumber === zoneNumber,
    );
    temperatureAccessory?.getService(this.Service.TemperatureSensor)
      ?.updateCharacteristic(this.Characteristic.CurrentTemperature, status.zone_temp);
  }

  private getSupportedSystemFanSpeeds(): number[] {
    const speeds: number[] = [];
    if (this.acAbility?.ac_support_fan_auto) speeds.push(MAGIC.AC_FAN_SPEEDS.AUTO);
    if (this.acAbility?.ac_support_fan_low) speeds.push(MAGIC.AC_FAN_SPEEDS.LOW);
    if (this.acAbility?.ac_support_fan_medium) speeds.push(MAGIC.AC_FAN_SPEEDS.MEDIUM);
    if (this.acAbility?.ac_support_fan_high) speeds.push(MAGIC.AC_FAN_SPEEDS.HIGH);
    return speeds.length ? speeds : [MAGIC.AC_FAN_SPEEDS.AUTO, MAGIC.AC_FAN_SPEEDS.LOW, MAGIC.AC_FAN_SPEEDS.HIGH];
  }

  private getSystemFanPercentage(): number {
    const speeds = this.getSupportedSystemFanSpeeds();
    const current = this.acStatus?.ac_fan_speed ?? speeds[0];
    const index = Math.max(0, speeds.indexOf(current));
    if (speeds.length === 1) return 100;
    return Math.round((index / (speeds.length - 1)) * 100);
  }

  private getAirTouchFanSpeedForPercentage(value: number): number {
    const speeds = this.getSupportedSystemFanSpeeds();
    if (speeds.length === 1) return speeds[0];
    const clamped = Math.max(0, Math.min(100, value));
    const index = Math.round((clamped / 100) * (speeds.length - 1));
    return speeds[index];
  }

  private getTargetModeForAirTouchMode(mode?: number): number {
    if (mode === MAGIC.AC_MODES.HEAT) {
      return this.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (mode === MAGIC.AC_MODES.COOL) {
      return this.Characteristic.TargetHeatingCoolingState.COOL;
    }
    return this.Characteristic.TargetHeatingCoolingState.AUTO;
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
