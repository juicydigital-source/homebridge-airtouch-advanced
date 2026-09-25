# Homebridge AirTouch Advanced

Advanced local AirTouch integration for Homebridge.

## Goal

Expose the AirTouch controls that are useful for Apple Home and Google Home automations, including:

- Air conditioner power and operating mode
- Fan speed (Auto / Low / High)
- Zone/room on and off
- Zone temperature and target temperature
- Zone damper/vent position
- Automation-friendly Homebridge accessories

## Status

Early development. Version 0.1.0 is the initial Homebridge platform scaffold. It does not control an AirTouch system yet.

## Development install

Clone the repository onto the Homebridge host, install dependencies, build it, and link the package:

```bash
git clone https://github.com/juicydigital-source/homebridge-airtouch-advanced.git
cd homebridge-airtouch-advanced
npm install
npm run build
sudo npm link
```

Restart Homebridge after linking the plugin.

## Configuration

Homebridge UI will provide an **AirTouch Advanced** platform configuration. The controller IP can be entered there.

Do not commit your real Homebridge configuration, tokens or local environment files to this repository.
