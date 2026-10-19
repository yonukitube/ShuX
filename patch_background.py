from pathlib import Path
import shutil
import sys

p = Path("shux.js")
s = p.read_text()

if "SHUX_BACKGROUND_MANAGER_V1" in s:
    print("Background manager already installed. No changes made.")
    sys.exit(0)

api_anchor = "const API_TOKEN = loadApiToken();"
old_shutdown = """function shutdown() {
  if (rl) rl.close();
  if (server) server.close();
  process.stdout.write('\\x1b[?25h\\x1b[2J\\x1b[H');
  console.log('ShuX closed.');
  process.exit(0);
}"""

startup_anchor = "server.listen(PORT, HOST);"

if s.count(api_anchor) != 1:
    print("ERROR: API token insertion point is missing or ambiguous.")
    sys.exit(1)

if s.count(old_shutdown) != 1:
    print("ERROR: Shutdown function differs from the expected version.")
    print("No changes made.")
    sys.exit(1)

if s.count(startup_anchor) != 1:
    print("ERROR: Server startup insertion point is missing or ambiguous.")
    sys.exit(1)

insert = r'''
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

  process.exit(0);
}
'''

new_shutdown = "async function shutdown() {\n  if (shuttingDown) return;\n  shuttingDown = true;\n\n  if (rl) rl.close();\n  const restored = await restoreBackgroundState();\n\n  try { await runTermuxCommand('termux-wake-unlock'); } catch {}\n  if (server) { try { server.close(); } catch {} }\n\n  process.stdout.write('\\\\x1b[?25h\\\\x1b[2J\\\\x1b[H');\n  console.log(restored\n    ? 'ShuX closed. Background settings restored.'\n    : 'ShuX closed. Some settings remain pending restoration; reconnect the original device and start ShuX again.');\n  process.exit(0);\n}"

new_startup = """server.listen(PORT, HOST);

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
process.on('SIGTERM', () => shutdown());"""

# Verify the exact replacement before writing.
s2 = s.replace(api_anchor, api_anchor + "\n" + insert, 1)
s2 = s2.replace(old_shutdown, new_shutdown, 1)
s2 = s2.replace(startup_anchor, new_startup, 1)

backup = Path("shux.js.before-background-manager")
if backup.exists():
    print(f"ERROR: {backup} already exists; refusing to overwrite it.")
    sys.exit(1)

shutil.copy2(p, backup)
p.write_text(s2)

print("Installed ShuX background manager.")
print(f"Backup: {backup}")
