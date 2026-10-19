from pathlib import Path
import sys

p = Path.home() / "ShuX" / "shux.js"
s = p.read_text()

if "async function discoverServices(" in s:
    print("The new discovery code is already installed.")
    sys.exit(0)

required = [
    "const { execFile } = require('node:child_process');",
    "const PORT = 8765;",
    "async function discoverService(",
    "async function executeCommand("
]

for item in required:
    if item not in s:
        print("ERROR: Expected code not found:", item)
        print("No changes made.")
        sys.exit(1)

discovery = Path.home() / "src/android-adb-helpers/bin/adb-mdns-discover"
if not discovery.is_file():
    print("ERROR: mDNS discovery script not found:")
    print(discovery)
    print("No changes made.")
    sys.exit(1)

backup = p.with_name("shux.js.backup")
backup.write_text(s)

s = s.replace(
    "const { execFile } = require('node:child_process');",
    "const { execFile } = require('node:child_process');\n"
    "const fs = require('node:fs');\n"
    "const os = require('node:os');\n"
    "const path = require('node:path');",
    1
)

s = s.replace(
    "const PORT = 8765;",
    "const PORT = 8765;\n"
    "const DISCOVERY_SCRIPT = path.join(os.homedir(), "
    "'src/android-adb-helpers/bin/adb-mdns-discover');\n"
    "const PAIR_STATE_FILE = path.join(os.homedir(), '.shux-paired');",
    1
)

start = s.index("async function discoverService(")
end = s.index("async function executeCommand(", start)

replacement = r'''
function wasPaired() {
  try {
    return fs.readFileSync(PAIR_STATE_FILE, 'utf8').trim() === 'yes';
  } catch {
    return false;
  }
}

function markPaired() {
  fs.writeFileSync(PAIR_STATE_FILE, 'yes\n', { mode: 0o600 });
}

async function discoverServices(seconds = 3) {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [DISCOVERY_SCRIPT, String(seconds)],
      { timeout: (seconds + 4) * 1000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }

        const services = {};

        for (const line of stdout.split(/\r?\n/)) {
          const match = line.trim().match(
            /^(pairing|connect)\s+(\S+)\s+(\d+)$/
          );

          if (match) {
            services[match[1]] = {
              host: match[2],
              port: Number(match[3]),
              address: `${match[2]}:${match[3]}`
            };
          }
        }

        resolve(services);
      }
    );
  });
}

async function getConnectedDevices() {
  const text = await adb(['devices']);
  return text.split(/\r?\n/).slice(1)
    .filter(line => /\bdevice$/.test(line.trim()));
}

async function tryDiscoveredConnection(services) {
  if (!services.connect) {
    return {
      connected: false,
      output: 'No connection service discovered.'
    };
  }

  try {
    const result = await adb(['connect', services.connect.address], 15000);
    const devices = await getConnectedDevices();

    if (devices.length) {
      markPaired();
      return {
        connected: true,
        output: result + '\n' + devices.join('\n')
      };
    }

    return { connected: false, output: result };
  } catch (e) {
    return { connected: false, output: e.message };
  }
}

async function reconnectFlow() {
  if (busy) return;

  busy = true;
  state = 'reconnect';
  inputBuffer = '';
  output = '';
  message = 'Discovering ADB services...';
  render();

  try {
    let services = await discoverServices(3);
    let result = await tryDiscoveredConnection(services);

    if (result.connected) {
      output = result.output;
      message = 'Connection successful.';
      busy = false;
      promptMain();
      return;
    }

    if (wasPaired()) {
      message = 'Retrying the existing paired connection...';
      render();

      services = await discoverServices(2);
      result = await tryDiscoveredConnection(services);

      output = result.output;
      message = result.connected
        ? 'Connection successful.'
        : 'Previously paired. Connection failed; pairing was not repeated.';

      busy = false;
      promptMain();
      return;
    }

    if (!services.pairing) {
      message = 'Searching for the pairing service...';
      render();

      const retry = await discoverServices(2);
      services = {
        pairing: retry.pairing || services.pairing,
        connect: retry.connect
      };

      result = await tryDiscoveredConnection(services);

      if (result.connected) {
        output = result.output;
        message = 'Connection successful.';
        busy = false;
        promptMain();
        return;
      }
    }

    if (services.pairing) {
      state = 'paircode';
      inputBuffer = '';
      output = '';
      message = services.pairing.address;
      busy = false;
      render();
      return;
    }

    output =
      'No pairing service was discovered.\n' +
      'Keep Wireless debugging enabled and the pairing dialog open, then retry.';
    message = 'Discovery failed.';
    busy = false;
    state = 'reconnect';
    render();
  } catch (e) {
    busy = false;
    state = 'reconnect';
    output = e.message;
    message = 'Reconnect failed.';
    render();
  }
}

async function finishPairing(code) {
  if (busy) return;

  if (!/^\d{6}$/.test(code)) {
    message = 'Enter the six-digit pairing code.';
    render();
    return;
  }

  const address = message;
  busy = true;
  state = 'reconnect';
  output = '';
  message = 'Pairing with Android...';
  render();

  try {
    output = await adb(['pair', address, code], 30000);
    markPaired();

    message = 'Pairing succeeded. Discovering connection service...';
    render();

    let services = await discoverServices(3);

    if (!services.connect) {
      const retry = await discoverServices(2);
      services = { ...services, connect: retry.connect };
    }

    if (!services.connect) {
      output += '\n\nPairing succeeded, but the connection service was not found.';
      message = 'Paired; connection is not yet confirmed.';
      busy = false;
      promptMain();
      return;
    }

    const result = await tryDiscoveredConnection(services);
    output += '\n' + result.output;
    message = result.connected
      ? 'Pairing and connection successful.'
      : 'Paired successfully, but connection failed.';

    busy = false;
    promptMain();
  } catch (e) {
    busy = false;
    state = 'reconnect';
    output = e.message;
    message = 'Pairing or connection failed.';
    render();
  }
}

'''

s = s[:start] + replacement + s[end:]
p.write_text(s)
print("ShuX updated successfully.")
print("Backup:", backup)
