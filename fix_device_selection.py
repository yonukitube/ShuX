from pathlib import Path
import sys

p = Path.home() / "ShuX" / "shux.js"
s = p.read_text()

start = s.find("function adb(args, timeout = 30000) {")
end = s.find("\nfunction parseArgs(", start)

if start < 0 or end < 0:
    print("ERROR: Could not locate the adb() function.")
    print("No changes made.")
    sys.exit(1)

replacement = r'''
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
'''

backup = p.with_name("shux.js.before-device-fix")
backup.write_text(s)
p.write_text(s[:start] + replacement + s[end:])

print("Updated ADB device selection.")
print("Backup saved to:", backup)
