const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');

const HOST = '127.0.0.1';
const PORT = 8765;
const DISCOVERY_SCRIPT = path.join(os.homedir(), 'src/android-adb-helpers/bin/adb-mdns-discover');
const PAIR_STATE_FILE = path.join(os.homedir(), '.shux-paired');

let state = 'main';
let busy = false;
let inputBuffer = '';
let output = '';
let message = 'Welcome to ShuX.';
let rl;
let server;
let webProcess;

// APP_REQUEST_API_INSTALLED
let appRequests = [];
let nextRequestId = 1;
let selectedRequestId = null;

const API_TOKEN_FILE = path.join(os.homedir(), '.shux-api-token');

function loadApiToken() {
  try {
    const existing = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {}

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(API_TOKEN_FILE, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(API_TOKEN_FILE, 0o600);
  } catch {}
  return token;
}

const API_TOKEN = loadApiToken();

// SHUX_PERSISTENT_APP_POLICIES
const APP_POLICY_FILE = path.join(os.homedir(), '.shux-app-policies.json');
const VALID_APP_POLICIES = new Set([
  'ask', 'always_allow', 'always_reject', 'disabled'
]);

function appPolicyKey(app) {
  return app.trim().toLowerCase();
}

function loadAppPolicies() {
  try {
    const value = JSON.parse(fs.readFileSync(APP_POLICY_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value : {};
  } catch {
    return {};
  }
}

let appPolicies = loadAppPolicies();

// SHUX_PERSISTENT_APP_REGISTRY_V1
const APP_REGISTRY_FILE = path.join(os.homedir(), '.shux-app-registry.json');
const MAX_REGISTERED_APPS = 200;

function loadAppRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(APP_REGISTRY_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value : {};
  } catch {
    return {};
  }
}

let appRegistry = loadAppRegistry();

function saveAppRegistry() {
  const temp = APP_REGISTRY_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(appRegistry, null, 2) + '\n',
    { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, APP_REGISTRY_FILE);
}

function registerApp(app) {
  const key = appPolicyKey(app);
  if (Object.prototype.hasOwnProperty.call(appRegistry, key)) return true;

  if (Object.keys(appRegistry).length >= MAX_REGISTERED_APPS) return false;

  appRegistry[key] = app;
  try {
    saveAppRegistry();
  } catch (error) {
    delete appRegistry[key];
    throw error;
  }
  return true;
}

// Restore applications known from existing saved policies.
let registrySeeded = false;
for (const key of Object.keys(appPolicies)) {
  if (!Object.prototype.hasOwnProperty.call(appRegistry, key)) {
    if (Object.keys(appRegistry).length >= MAX_REGISTERED_APPS) break;
    appRegistry[key] = key;
    registrySeeded = true;
  }
}
if (registrySeeded) {
  try { saveAppRegistry(); } catch (error) {
    console.error('Could not seed application registry:', error.message);
  }
}

// SHUX_REQUEST_RATE_LIMIT_V1
const APP_RATE_WINDOW_MS = 60_000;
const APP_RATE_BLOCK_MS = 60_000;
const APP_RATE_MAX = 10;
const appRateStates = new Map();

function checkAppRate(app) {
  const key = appPolicyKey(app);
  const now = Date.now();
  let state = appRateStates.get(key);

  if (!state) {
    state = { timestamps: [], blockedUntil: 0 };
    appRateStates.set(key, state);
  }

  if (state.blockedUntil > now) {
    return {
      allowed: false,
      retryAfter: Math.ceil((state.blockedUntil - now) / 1000)
    };
  }

  state.blockedUntil = 0;
  state.timestamps = state.timestamps.filter(
    timestamp => now - timestamp < APP_RATE_WINDOW_MS
  );

  if (state.timestamps.length >= APP_RATE_MAX) {
    state.blockedUntil = now + APP_RATE_BLOCK_MS;
    return { allowed: false, retryAfter: 60 };
  }

  state.timestamps.push(now);
  return { allowed: true, retryAfter: 0 };
}


function getAppPolicy(app) {
  return appPolicies[appPolicyKey(app)] || 'ask';
}

function saveAppPolicies() {
  const temp = APP_POLICY_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(appPolicies, null, 2) + '\n',
    { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, APP_POLICY_FILE);
}


// SHUX_BACKGROUND_MANAGER_V1
const BACKGROUND_STATE_FILE = path.join(os.homedir(), '.shux-background-state.json');

let backgroundState = null;
let backgroundSetupRunning = false;
let shuttingDown = false;

function saveBackgroundSnapshot(snapshot) {
  const temp = BACKGROUND_STATE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', {
    mode: 0o600
  });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, BACKGROUND_STATE_FILE);
}

function readBackgroundSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(BACKGROUND_STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error('Cannot read background recovery state: ' + e.message);
  }
}

async function getOnlineSerials() {
  const listing = await runAdbRaw(['devices', '-l'], 10000);
  const serials = [];

  for (const line of listing.split(/\r?\n/).slice(1)) {
    const match = line.trim().match(/^(\S+)\s+device(?:\s|$)/);
    if (match) serials.push(match[1]);
  }

  return serials;
}

async function shellFor(serial, args) {
  return runAdbRaw(['-s', serial, 'shell', ...args], 15000);
}

async function getAndroidId(serial) {
  try {
    const id = (await shellFor(serial, [
      'settings', 'get', 'secure', 'android_id'
    ])).trim();

    if (!id || id === 'null' || id === '(No output)') return null;
    return id;
  } catch {
    return null;
  }
}

async function findSavedDevice(snapshot) {
  const serials = await getOnlineSerials();

  if (snapshot.androidId) {
    for (const serial of serials) {
      const id = await getAndroidId(serial);
      if (id && id === snapshot.androidId) return serial;
    }
    return null;
  }

  return serials.includes(snapshot.serial) ? snapshot.serial : null;
}

async function readAppOpMode(serial, op) {
  const result = await shellFor(serial, [
    'cmd', 'appops', 'get', 'com.termux', op
  ]);

  const escaped = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = result.match(
    new RegExp('(?:^|\\n)\\s*' + escaped +
      ':\\s*(allow|ignore|deny|default|foreground|errored)\\b', 'i')
  );

  // "No operations" means the operation has no explicit override.
  return match ? match[1].toLowerCase() : 'default';
}

async function runTermuxCommand(command) {
  return new Promise((resolve, reject) => {
    execFile(command, [], { timeout: 5000 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function restoreBackgroundState() {
  let snapshot;

  try {
    snapshot = readBackgroundSnapshot();
  } catch (e) {
    console.error('\nShuX recovery warning: ' + e.message);
    return false;
  }

  if (!snapshot) {
    backgroundState = null;
    return true;
  }

  let allRestored = true;
  let serial = null;

  try {
    serial = await findSavedDevice(snapshot);
  } catch (e) {
    console.error('\nCould not find the original ADB device: ' + e.message);
  }

  if (!serial) {
    console.error(
      '\nShuX: original device is not connected; ' +
      'background settings will be restored when it reconnects.'
    );
    allRestored = false;
  } else {
    if (snapshot.originalModes) {
      for (const [op, mode] of Object.entries(snapshot.originalModes)) {
        try {
          await shellFor(serial, [
            'cmd', 'appops', 'set', 'com.termux', op, mode
          ]);
        } catch (e) {
          console.error('\nCould not restore ' + op + ': ' + e.message);
          allRestored = false;
        }
      }
    }

    if (snapshot.addedDozeExemption) {
      try {
        const current = await shellFor(serial, [
          'dumpsys', 'deviceidle', 'whitelist'
        ]);

        if (current.includes('com.termux')) {
          await shellFor(serial, [
            'dumpsys', 'deviceidle', 'whitelist', '-com.termux'
          ]);
        }
      } catch (e) {
        console.error('\nCould not restore Doze whitelist: ' + e.message);
        allRestored = false;
      }
    }
  }

  if (snapshot.wakeLockMayNeedUnlock) {
    try {
      await runTermuxCommand('termux-wake-unlock');
    } catch (e) {
      console.error('\nCould not release Termux wake lock: ' + e.message);
      allRestored = false;
    }
  }

  if (allRestored) {
    try {
      fs.unlinkSync(BACKGROUND_STATE_FILE);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('\nCould not remove recovery state: ' + e.message);
        allRestored = false;
      }
    }
  }

  backgroundState = null;
  return allRestored;
}

async function enableBackgroundProtection() {
  if (backgroundSetupRunning || backgroundState || shuttingDown) return;

  backgroundSetupRunning = true;

  try {
    // Recover a previous interrupted session before changing anything.
    const recovered = await restoreBackgroundState();
    if (!recovered) return;

    const serials = await getOnlineSerials();

    if (serials.length !== 1) {
      // Do not guess which phone should receive the settings.
      return;
    }

    const serial = serials[0];
    const androidId = await getAndroidId(serial);

    const whitelist = await shellFor(serial, [
      'dumpsys', 'deviceidle', 'whitelist'
    ]);

    const wasWhitelisted = whitelist.includes('com.termux');

    const originalModes = {
      RUN_IN_BACKGROUND: await readAppOpMode(serial, 'RUN_IN_BACKGROUND'),
      RUN_ANY_IN_BACKGROUND: await readAppOpMode(serial, 'RUN_ANY_IN_BACKGROUND')
    };

    const snapshot = {
      version: 1,
      serial,
      androidId,
      originalModes,
      addedDozeExemption: !wasWhitelisted,
      wakeLockMayNeedUnlock: false
    };

    // Persist recovery data before changing Android settings.
    saveBackgroundSnapshot(snapshot);

    if (!wasWhitelisted) {
      await shellFor(serial, [
        'dumpsys', 'deviceidle', 'whitelist', '+com.termux'
      ]);
    }

    await shellFor(serial, [
      'cmd', 'appops', 'set', 'com.termux',
      'RUN_IN_BACKGROUND', 'allow'
    ]);

    await shellFor(serial, [
      'cmd', 'appops', 'set', 'com.termux',
      'RUN_ANY_IN_BACKGROUND', 'allow'
    ]);

    // Record the intended cleanup before acquiring the wake lock.
    snapshot.wakeLockMayNeedUnlock = true;
    saveBackgroundSnapshot(snapshot);

    await runTermuxCommand('termux-wake-lock');

    backgroundState = snapshot;

    if (state === 'main') {
      message = 'Background protection enabled; settings will be restored on exit.';
      render();
    }
  } catch (e) {
    console.error('\nShuX background setup: ' + e.message);
    // If setup partially changed Android, attempt to roll it back.
    await restoreBackgroundState();
  } finally {
    backgroundSetupRunning = false;
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (rl) rl.close();

  const restored = await restoreBackgroundState();

  // Also release a wake lock previously requested manually in Termux.
  try {
    await runTermuxCommand('termux-wake-unlock');
  } catch {}

  if (server) {
    try {
      server.close();
    } catch {}
  }

  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');

  if (restored) {
    console.log('ShuX closed. Background settings restored.');
  } else {
    console.log(
      'ShuX closed. Some settings could not be restored yet; ' +
      'reconnect the original device and start ShuX again.'
    );
  }

  if (webProcess && !webProcess.killed) {
    try { webProcess.kill('SIGTERM'); } catch {}
  }

  process.exit(0);
}


const ALLOWED_APP_ACTIONS = new Set([
  'get_android_version',
  'get_device_identity',
  'list_devices'
]);


async function executeAllowedAction(action) {
  if (!ALLOWED_APP_ACTIONS.has(action)) {
    throw new Error('This action is not allowed.');
  }

  if (action === 'get_android_version') {
    return await adb(['shell', 'getprop', 'ro.build.version.release']);
  }
  if (action === 'get_device_identity') {
    return await adb(['shell', 'id']);
  }
  if (action === 'list_devices') {
    return await adb(['devices', '-l']);
  }

  throw new Error('This action is not allowed.');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 8192) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

function publicRequest(r) {
  return {
    id: r.id,
    app: r.app,
    policy: getAppPolicy(r.app),
    action: r.action,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    result: r.result
  };
}

function findRequest(id) {
  return appRequests.find(r => r.id === Number(id));
}

async function approveSelectedRequest() {
  const r = findRequest(selectedRequestId);
  if (!r || r.status !== 'pending' || busy) return;

  busy = true;
  message = 'Executing approved request...';
  output = '';
  render();

  try {
    if (r.action === 'get_android_version') {
      r.result = await adb(['shell', 'getprop', 'ro.build.version.release']);
    } else if (r.action === 'get_device_identity') {
      r.result = await adb(['shell', 'id']);
    } else if (r.action === 'list_devices') {
      r.result = await adb(['devices', '-l']);
    } else {
      throw new Error('This action is not allowed.');
    }

    r.status = 'completed';
  } catch (e) {
    r.status = 'failed';
    r.result = e.message;
  }

  r.updatedAt = new Date().toISOString();
  output = String(r.result ?? '');
  message = 'Request ' + r.status + '.';
  busy = false;
  state = 'appdetail';
  render();
}

function rejectSelectedRequest() {
  const r = findRequest(selectedRequestId);
  if (!r || r.status !== 'pending') return;

  r.status = 'rejected';
  r.result = 'Rejected by the user.';
  r.updatedAt = new Date().toISOString();
  state = 'apps';
  output = '';
  message = 'Request rejected.';
  render();
}



function runAdbRaw(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, {
      timeout,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      const result = [stdout, stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      if (error) {
        reject(new Error(result || error.message));
      } else {
        resolve(result || '(No output)');
      }
    });
  });
}

async function adb(args, timeout = 30000) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('No ADB arguments supplied.');
  }

  const globalCommands = new Set([
    'devices',
    'connect',
    'pair',
    'disconnect',
    'start-server',
    'kill-server',
    'version',
    'help',
    'keygen',
    'pubkey',
    'server-status'
  ]);

  const first = args[0];

  // Commands that manage ADB itself or its connections
  // must not be assigned to a particular device.
  if (globalCommands.has(first)) {
    return runAdbRaw(args, timeout);
  }

  // Respect an explicit device selector supplied by the user.
  if (
    args.includes('-s') ||
    args.includes('-t') ||
    args.includes('-d') ||
    args.includes('-e')
  ) {
    return runAdbRaw(args, timeout);
  }

  // Find devices without applying automatic selection.
  const listing = await runAdbRaw(['devices', '-l'], 10000);

  const online = [];
  for (const line of listing.split(/\r?\n/).slice(1)) {
    const match = line.trim().match(/^(\S+)\s+device(?:\s|$)/);
    if (match) online.push(match[1]);
  }

  if (online.length === 0) {
    throw new Error(
      'No online ADB device found. Open Wireless debugging and reconnect.'
    );
  }

  if (online.length > 1) {
    throw new Error(
      'Multiple online ADB devices found: ' + online.join(', ') +
      '. Specify one with -s SERIAL.'
    );
  }

  // Exactly one online device: select it automatically.
  return runAdbRaw(['-s', online[0], ...args], timeout);
}

function parseArgs(line) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;

  while ((match = re.exec(line)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }

  if (args[0] === 'adb') args.shift();
  return args;
}

function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function render() {
  return; // Web UI: disable legacy terminal menu
}

function promptMain() {
  state = 'main';
  inputBuffer = '';
  message = 'Ready.';
  output = '';
  render();
}


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

async function executeCommand(line) {
  const args = parseArgs(line);

  if (!args.length) {
    state = 'commands';
    inputBuffer = '';
    render();
    return;
  }

  if (args[0] === 'exit' || args[0] === 'quit') {
    promptMain();
    return;
  }

  busy = true;
  output = '';
  message = 'Executing ADB command...';
  render();

  try {
    output = await adb(args);
    message = 'Command completed.';
  } catch (e) {
    output = 'ERROR: ' + e.message;
    message = 'Command failed.';
  }

  busy = false;
  state = 'commands';
  inputBuffer = '';
  render();
}

function handleEnter(value) {
  if (state === 'main') {
    if (value === '1') reconnectFlow();
    else if (value === '2') {
      state = 'apps';
      output = '';
      message = 'Waiting for application requests.';
      render();
    } else if (value === '3') {
      state = 'commands';
      inputBuffer = '';
      output = '';
      message = 'Ready.';
      render();
    } else if (value === '0') {
      shutdown();
    } else {
      message = 'Invalid option. Try again.';
      render();
    }
  } else if (state === 'apps') {
    if (value === '0') {
      promptMain();
    } else if (value.toLowerCase() === 'r') {
      message = 'Requests refreshed.';
      render();
    } else if (/^\d+$/.test(value)) {
      const pending = appRequests.filter(r => r.status === 'pending');
      const r = pending[Number(value) - 1];

      if (!r) {
        message = 'Invalid request number.';
        render();
      } else {
        selectedRequestId = r.id;
        state = 'appdetail';
        output = '';
        message = 'Review the application request.';
        render();
      }
    } else {
      message = 'Enter a request number, r, or 0.';
      render();
    }
  } else if (state === 'appdetail') {
    const r = findRequest(selectedRequestId);

    if (value === '0') {
      state = 'apps';
      output = '';
      message = 'Returned to requests.';
      render();
    } else if (r && r.status === 'pending' && value === '1') {
      approveSelectedRequest();
    } else if (r && r.status === 'pending' && value === '2') {
      rejectSelectedRequest();
    } else {
      message = 'Invalid option.';
      render();
    }
  } else if (state === 'commands') {
    executeCommand(value);
  } else if (state === 'paircode') {
    finishPairing(value);
  } else if (state === 'reconnect') {
    if (value === '0') promptMain();
    else reconnectFlow();
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (rl) rl.close();
  const restored = await restoreBackgroundState();

  try { await runTermuxCommand('termux-wake-unlock'); } catch {}
  if (server) { try { server.close(); } catch {} }

  process.stdout.write('\\x1b[?25h\\x1b[2J\\x1b[H');
  console.log(restored
    ? 'ShuX closed. Background settings restored.'
    : 'ShuX closed. Some settings remain pending restoration; reconnect the original device and start ShuX again.');
  if (webProcess && !webProcess.killed) {
    try { webProcess.kill('SIGTERM'); } catch {}
  }

  process.exit(0);
}

// Start the web interface automatically.
webProcess = spawn(process.execPath, [path.join(__dirname, 'web.js')], {
  stdio: 'ignore'
});

webProcess.on('error', err => {
  console.error('ShuX Web failed to start: ' + err.message);
});

server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { name: 'ShuX', status: 'running' });
  }

  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + API_TOKEN) {
    return sendJson(res, 401, { error: 'Unauthorized. Supply the ShuX API token.' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/devices') {
      return sendJson(res, 200, { devices: await adb(['devices', '-l']) });
    }

    if (req.method === 'GET' && url.pathname === '/identity') {
      return sendJson(res, 200, { identity: await adb(['shell', 'id']) });
    }


    // SHUX_DELETE_APP_V1
    if (req.method === 'POST' && url.pathname === '/apps/delete') {
      const body = await readJsonBody(req);
      const app = typeof body.app === 'string' ? body.app.trim() : '';

      if (!app || app.length > 80) {
        return sendJson(res, 400, { error: 'App name must be 1 to 80 characters.' });
      }

      const key = appPolicyKey(app);
      const oldRegistry = { ...appRegistry };
      const oldPolicies = { ...appPolicies };
      const oldRequests = appRequests;
      const oldRateState = appRateStates.get(key);

      delete appRegistry[key];
      delete appPolicies[key];
      appRequests = appRequests.filter(r => appPolicyKey(r.app) !== key);
      appRateStates.delete(key);

      try {
        saveAppRegistry();
        saveAppPolicies();
      } catch (error) {
        appRegistry = oldRegistry;
        appPolicies = oldPolicies;
        appRequests = oldRequests;
        if (oldRateState) appRateStates.set(key, oldRateState);
        try { saveAppRegistry(); } catch {}
        try { saveAppPolicies(); } catch {}
        return sendJson(res, 500, {
          error: 'Could not delete application safely: ' + error.message
        });
      }

      return sendJson(res, 200, { app, deleted: true });
    }

    if (req.method === 'GET' && url.pathname === '/policies') {
      return sendJson(res, 200, { policies: appPolicies });
    }

    if (req.method === 'POST' && url.pathname === '/policies') {
      const body = await readJsonBody(req);
      const app = typeof body.app === 'string' ? body.app.trim() : '';
      const policy = typeof body.policy === 'string' ? body.policy : '';

      if (!app || app.length > 80) {
        return sendJson(res, 400, { error: 'App name must be 1 to 80 characters.' });
      }
      if (!VALID_APP_POLICIES.has(policy)) {
        return sendJson(res, 400, { error: 'Invalid application policy.' });
      }

      const key = appPolicyKey(app);
      const previous = appPolicies[key];

      if (policy === 'ask') {
        delete appPolicies[key];
      } else {
        appPolicies[key] = policy;
      }

      try {
        saveAppPolicies();
      } catch (error) {
        if (previous === undefined) delete appPolicies[key];
        else appPolicies[key] = previous;
        return sendJson(res, 500, { error: 'Could not save policy: ' + error.message });
      }

      return sendJson(res, 200, {
        app,
        policy: getAppPolicy(app),
        saved: true
      });
    }

    if (req.method === 'GET' && url.pathname === '/requests') {
      const requests = appRequests.map(publicRequest);
      const apps = Object.entries(appRegistry).map(([key, app]) => {
        const latestRequest = [...appRequests].reverse().find(
          r => appPolicyKey(r.app) === key
        );
        return {
          app,
          policy: getAppPolicy(app),
          latestRequest: latestRequest ? publicRequest(latestRequest) : null
        };
      });
      return sendJson(res, 200, { requests, apps });
    }

    const requestMatch = url.pathname.match(/^\/requests\/(\d+)$/);
    if (req.method === 'GET' && requestMatch) {
      const r = findRequest(requestMatch[1]);
      if (!r) return sendJson(res, 404, { error: 'Request not found.' });
      return sendJson(res, 200, { request: publicRequest(r) });
    }


    if (req.method === 'POST' && url.pathname === '/commands') {
      const body = await readJsonBody(req);
      const command = typeof body.command === 'string'
        ? body.command.trim() : '';

      if (!command || command.length > 2000) {
        return sendJson(res, 400, {
          error: 'Enter a command of 1 to 2000 characters.'
        });
      }

      const args = parseArgs(command);
      if (!args.length) {
        return sendJson(res, 400, { error: 'Empty command.' });
      }

      const result = await adb(args);
      return sendJson(res, 200, { output: result });
    }

    if (req.method === 'POST' && url.pathname === '/reconnect') {
      if (busy) {
        return sendJson(res, 409, { error: 'ShuX is busy.' });
      }

      busy = true;
      try {
        let services = await discoverServices(3);
        let result = await tryDiscoveredConnection(services);

        if (!result.connected && wasPaired()) {
          services = await discoverServices(2);
          result = await tryDiscoveredConnection(services);
        }

        if (!result.connected && !wasPaired() && !services.pairing) {
          const retry = await discoverServices(2);
          services = {
            pairing: retry.pairing || services.pairing,
            connect: retry.connect
          };
          result = await tryDiscoveredConnection(services);
        }

        if (result.connected) {
          return sendJson(res, 200, {
            connected: true,
            message: 'Connection successful.',
            output: result.output
          });
        }

        if (services.pairing && !wasPaired()) {
          return sendJson(res, 200, {
            connected: false,
            needsPairing: true,
            pairingAddress: services.pairing.address,
            message: 'Enter the pairing code shown in Android Wireless debugging.'
          });
        }

        return sendJson(res, 200, {
          connected: false,
          message: 'Connection failed. Keep Wireless debugging enabled and try again.',
          output: result.output
        });
      } finally {
        busy = false;
      }
    }

    if (req.method === 'POST' && url.pathname === '/pair') {
      if (busy) {
        return sendJson(res, 409, { error: 'ShuX is busy.' });
      }

      const body = await readJsonBody(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';

      if (!/^\d{6}$/.test(code)) {
        return sendJson(res, 400, {
          error: 'Enter the six-digit pairing code.'
        });
      }

      busy = true;
      try {
        const services = await discoverServices(3);
        if (!services.pairing) {
          return sendJson(res, 409, {
            error: 'Pairing service not found. Open the pairing dialog in Android Wireless debugging and retry.'
          });
        }

        const pairingOutput = await adb(
          ['pair', services.pairing.address, code], 30000
        );
        markPaired();

        let connections = await discoverServices(3);
        if (!connections.connect) {
          const retry = await discoverServices(2);
          connections = { ...connections, connect: retry.connect };
        }

        if (!connections.connect) {
          return sendJson(res, 200, {
            paired: true,
            connected: false,
            output: pairingOutput,
            message: 'Paired, but the connection service was not found. Try Reconnect.'
          });
        }

        const result = await tryDiscoveredConnection(connections);
        return sendJson(res, 200, {
          paired: true,
          connected: result.connected,
          output: pairingOutput + '\n' + result.output,
          message: result.connected
            ? 'Pairing and connection successful.'
            : 'Paired, but connection failed. Try Reconnect.'
        });
      } finally {
        busy = false;
      }
    }

    const requestActionMatch =
      url.pathname.match(/^\/requests\/(\d+)\/(approve|reject)$/);

    if (req.method === 'POST' && requestActionMatch) {
      const r = findRequest(requestActionMatch[1]);
      if (!r) {
        return sendJson(res, 404, { error: 'Request not found.' });
      }
      if (r.status !== 'pending') {
        return sendJson(res, 409, {
          error: 'This request is no longer pending.',
          request: publicRequest(r)
        });
      }

      if (requestActionMatch[2] === 'reject') {
        r.status = 'rejected';
        r.result = 'Rejected by the user.';
        r.updatedAt = new Date().toISOString();
        return sendJson(res, 200, {
          request: publicRequest(r)
        });
      }

      if (busy) {
        return sendJson(res, 409, { error: 'ShuX is busy.' });
      }

      busy = true;
      try {
        try {
          if (r.action === 'get_android_version') {
            r.result = await adb([
              'shell', 'getprop', 'ro.build.version.release'
            ]);
          } else if (r.action === 'get_device_identity') {
            r.result = await adb(['shell', 'id']);
          } else if (r.action === 'list_devices') {
            r.result = await adb(['devices', '-l']);
          } else {
            throw new Error('This action is not allowed.');
          }
          r.status = 'completed';
        } catch (e) {
          r.status = 'failed';
          r.result = e.message;
        }

        r.updatedAt = new Date().toISOString();
        return sendJson(res, 200, { request: publicRequest(r) });
      } finally {
        busy = false;
      }
    }

    if (req.method === 'POST' && url.pathname === '/request') {
      const body = await readJsonBody(req);
      const app = typeof body.app === 'string' ? body.app.trim() : '';
      const action = typeof body.action === 'string' ? body.action : '';

      if (!app || app.length > 80) {
        return sendJson(res, 400, { error: 'app must be 1 to 80 characters.' });
      }

      if (!ALLOWED_APP_ACTIONS.has(action)) {
        return sendJson(res, 400, {
          error: 'Unsupported action.',
          allowedActions: Array.from(ALLOWED_APP_ACTIONS)
        });
      }

      // Register before checking policy, so Disabled apps remain visible.
      if (!registerApp(app)) {
        return sendJson(res, 429, {
          error: 'Application registry is full. Delete an unused app first.'
        });
      }

      const policy = getAppPolicy(app);

      // Avoid duplicate pending requests without consuming the rate quota.
      if (policy === 'ask') {
        const duplicate = appRequests.find(r =>
          appPolicyKey(r.app) === appPolicyKey(app) &&
          r.action === action && r.status === 'pending'
        );
        if (duplicate) {
          return sendJson(res, 200, {
            request: publicRequest(duplicate),
            duplicate: true
          });
        }
      }

      // SHUX_REQUEST_RATE_LIMIT_V1
      const rate = checkAppRate(app);
      if (!rate.allowed) {
        return sendJson(res, 429, {
          error: 'Too many requests from this app. Try again later.',
          retryAfterSeconds: rate.retryAfter
        });
      }

      if (policy === 'disabled') {
        return sendJson(res, 403, {
          error: 'Requests from this app are disabled.',
          app,
          policy
        });
      }

      if (policy === 'always_allow' && busy) {
        return sendJson(res, 409, {
          error: 'ShuX is busy; automatic request was not executed. Retry later.'
        });
      }

      const now = new Date().toISOString();
      const r = {
        id: nextRequestId++,
        app,
        action,
        status: policy === 'always_reject' ? 'rejected' : 'pending',
        createdAt: now,
        updatedAt: policy === 'always_reject' ? now : null,
        result: policy === 'always_reject'
          ? 'Automatically rejected by the saved application policy.'
          : null
      };

      appRequests.push(r);
      if (appRequests.length > 100) {
        appRequests = appRequests.slice(-100);
      }

      if (policy === 'always_allow') {
        busy = true;
        try {
          try {
            r.result = await executeAllowedAction(r.action);
            r.status = 'completed';
          } catch (error) {
            r.result = error.message;
            r.status = 'failed';
          }
          r.updatedAt = new Date().toISOString();
        } finally {
          busy = false;
        }
      }

      return sendJson(res, 202, { request: publicRequest(r) });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('\nNotice: local API port 8765 is already in use.');
    console.log('The ShuX terminal interface will still run.');
  } else {
    console.error(err.message);
  }
});

server.listen(PORT, HOST);

// Enable protections only after ADB has one unambiguous online device.
// Retry periodically if wireless debugging becomes available later.
setTimeout(() => {
  enableBackgroundProtection().catch(e =>
    console.error('ShuX background setup: ' + e.message)
  );
}, 1500);

const backgroundRetryTimer = setInterval(() => {
  enableBackgroundProtection().catch(e =>
    console.error('ShuX background setup: ' + e.message)
  );
}, 30000);
backgroundRetryTimer.unref();

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

