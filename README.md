<p align="center"><img src="public/logo.svg" alt="Etherhaze" width="560"></p>

<p align="center"><b>Ether Dream emulator and RGB laser simulator for haze and smoke.</b><br>Build and test laser shows in TouchDesigner or MadMapper—without a physical laser.</p>

Etherhaze pretends to be one or more Ether Dream laser DACs on your network. TouchDesigner or MadMapper can stream to it exactly as they would to real hardware. It simulates galvo inertia, color-modulation limits, blanking tails, and flicker, then renders beams in 3D haze and smoke with live alerts.

## Features

- Ether Dream TCP and UDP-discovery emulator with a 1,799-point buffer.
- Up to eight independently positioned and configured lasers.
- Simulated galvo, scan-angle, color, TTL/analog, gamma, diode-threshold, and color-delay limitations.
- 3D beams in haze and smoke, with wind, clouds, floor and wall impacts, and crowd silhouettes.
- Art-Net and sACN DMX fixture simulation: RGB/RGBW PARs plus wash and beam moving heads.
- Saved scenes, quick camera views, a galvo scope, and live DAC, quality, and audience-zone alerts.

## Installation

Install [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Lectrov/etherhaze.git
cd etherhaze
npm install
npm start
```

On Windows, you can also double-click **`start.bat`**. Open <http://localhost:8080>.

## TouchDesigner setup

Create one **Laser Device CHOP** per laser:

| Parameter | Value |
|---|---|
| Type | `EtherDream` |
| Network Address | `127.0.0.1`, or the Etherhaze computer IP |
| Network Port | `7765` for laser 1, `7766` for laser 2, and so on |
| Queue Time | `0.05` at 30,000 pps; keep Queue Time × point rate below 1799 |

MadMapper automatically discovers laser 1 on the standard port, 7765.

For DMX, use a **DMX Out CHOP** with Art-Net or sACN and the Etherhaze computer address. In Etherhaze, add fixtures, configure their universe and address, and use the live channel list as the required CHOP channel order. Art-Net universes start at 0; sACN universes start at 1.

## Test without a laser application

```bash
npm run test-sender                       # clean pattern, laser 1
node tools/test-sender.js --bad           # deliberately broken pattern
node tools/test-sender.js --port 7766     # target laser 2
npm run dmx-test                          # animate wash moving heads over Art-Net
```

## Performance guidance

- Keep **Queue Time × point rate below 1799** or the DAC drops points.
- Keep TouchDesigner responsive: a pause of roughly 50 ms can empty the buffer and stop playback.
- Target **40–150 fps** in the refresh-rate alert. Below this range, flicker can be visible; above it, galvos may not keep up.
- **POPs** are generally lighter than SOPs for animated laser content.

## Project structure

```text
server.js              web server, laser management, and UDP discovery
lib/dac.js             Ether Dream emulator, TCP protocol, buffer, playback
lib/dmx.js             Art-Net and sACN receiver
public/fixtures.js     DMX fixture profiles and rendering
public/crowd.js        crowd silhouettes
public/sim.js          projector simulation
public/app.js          UI, Three.js rendering, and alerts
tools/test-sender.js   Ether Dream test sender
```

## Limitations and laser safety

- The protocol follows the open-source Ether Dream firmware; newer hardware revisions may use a larger buffer.
- Galvo and diode physics are useful approximations, not a replacement for calibration on real equipment.
- The audience-beam alert is a warning, **not a laser-safety assessment**. Any real installation—especially audience scanning—must be designed, measured, and approved by qualified laser-safety professionals under applicable local regulations.

## License

MIT. See [LICENSE](LICENSE).

Ether Dream is a trademark of its respective owners. Etherhaze is an independent project that emulates the public DAC protocol.
