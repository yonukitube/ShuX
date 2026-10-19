from pathlib import Path
import sys

p = Path.home() / "ShuX" / "shux.js"
s = p.read_text()

if "APP_REQUEST_API_INSTALLED" in s:
    print("The app request API is already installed.")
    sys.exit(0)

# Verify all insertion points before changing anything.
checks = [
    "const { execFile } = require('node:child_process');",
    "let server;",
    "} else if (state === 'apps') {",
    "} else if (state === 'commands') {",
    "function handleEnter(value) {",
    "function shutdown() {",
    "server = http.createServer(async (req, res) => {",
    "server.on('error', err => {"
]

for item in checks:
    if item not in s:
        print("ERROR: Expected code not found:", repr(item))
        print("No changes made.")
        sys.exit(1)

backup = p.with_name("shux.js.before-app-requests")
backup.write_text(s)

# Add crypto and API state.
s = s.replace(
    "const { execFile } = require('node:child_process');",
    "const { execFile } = require('node:child_process');\n"
    "const crypto = require('node:crypto');",
    1
)

s = s.replace(
    "let server;",
    """let server;

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
  fs.writeFileSync(API_TOKEN_FILE, token + '\\n', { mode: 0o600 });
  try {
    fs.chmodSync(API_TOKEN_FILE, 0o600);
  } catch {}
  return token;
}

const API_TOKEN = loadApiToken();

const ALLOWED_APP_ACTIONS = new Set([
  'get_android_version',
  'get_device_identity',
  'list_devices'
]);

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
""",
    1
)

# Replace the Required Apps display.
apps_start = s.index("  } else if (state === 'apps') {")
commands_start = s.index("  } else if (state === 'commands') {", apps_start)

apps_ui = """  } else if (state === 'apps') {
    console.log('REQUIRED APPS\\\\n');

    const pending = appRequests.filter(r => r.status === 'pending');
    console.log('Pending Requests: ' + pending.length + '\\\\n');

    if (pending.length === 0) {
      console.log('No pending requests.');
    } else {
      pending.forEach((r, i) => {
        console.log((i + 1) + '. ' + r.app);
        console.log('   Action: ' + r.action);
        console.log('   Status: ' + r.status + '\\\\n');
      });
      console.log('Enter a request number to review it.\\\\n');
    }

    console.log('r. Refresh requests');
    console.log('0. Main Menu');
  } else if (state === 'appdetail') {
    const r = findRequest(selectedRequestId);
    console.log('APP REQUEST DETAILS\\\\n');

    if (!r) {
      console.log('Request not found.');
      console.log('0. Back');
    } else {
      console.log('Request ID: ' + r.id);
      console.log('App label: ' + r.app);
      console.log('Action: ' + r.action);
      console.log('Status: ' + r.status);

      if (r.result !== null) {
        console.log('\\\\nResult: ' + String(r.result));
      }

      console.log('');
      if (r.status === 'pending') {
        console.log('1. Approve and execute');
        console.log('2. Reject');
      }
      console.log('0. Back to requests');
    }
"""

s = s[:apps_start] + apps_ui + s[commands_start:]

# Replace the input dispatcher.
hstart = s.index("function handleEnter(value) {")
hend = s.index("function shutdown() {", hstart)

handler = """function handleEnter(value) {
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
    } else if (/^\\\\d+$/.test(value)) {
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

"""

s = s[:hstart] + handler + s[hend:]

# Replace the existing HTTP server with authenticated request routes.
server_start = s.index("server = http.createServer(async (req, res) => {")
server_end = s.index("server.on('error', err => {", server_start)

server_code = """server = http.createServer(async (req, res) => {
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

    if (req.method === 'GET' && url.pathname === '/requests') {
      return sendJson(res, 200, {
        requests: appRequests.map(publicRequest)
      });
    }

    const requestMatch = url.pathname.match(/^\\\\/requests\\\\/(\\\\d+)$/);
    if (req.method === 'GET' && requestMatch) {
      const r = findRequest(requestMatch[1]);
      if (!r) return sendJson(res, 404, { error: 'Request not found.' });
      return sendJson(res, 200, { request: publicRequest(r) });
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

      const r = {
        id: nextRequestId++,
        app,
        action,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: null,
        result: null
      };

      appRequests.push(r);
      if (appRequests.length > 100) {
        appRequests = appRequests.slice(-100);
      }

      return sendJson(res, 202, { request: publicRequest(r) });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

"""

s = s[:server_start] + server_code + s[server_end:]

p.write_text(s)
print("Installed the ShuX application request prototype.")
print("Backup saved to:", backup)
