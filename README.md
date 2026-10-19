ShuX

ShuX is a local Android control interface built with Node.js and ADB. It provides a browser-based dashboard for managing Android debugging connections, executing ADB commands, and allowing compatible applications to request a small set of approved device operations.

ShuX is designed to run locally on Android through Termux.

Features

- Web dashboard: Manage ShuX from a local browser interface.
- ADB integration: Execute supported ADB commands and inspect connected devices.
- Wireless debugging: Pair and reconnect to Android devices using Android Wireless Debugging.
- Application requests: Compatible apps can request supported operations through a local HTTP API.
- Permission policies: Choose whether requests should require approval, be automatically allowed, automatically rejected, or disabled.
- Request management: Review, approve, or reject pending application requests.
- Persistent app policies: Save application policies between restarts.
- Local API authentication: Protect API requests with a generated bearer token.
- Background support: ShuX includes background-management and recovery functionality.

Requirements

- An Android device with "Termux" (https://github.com/termux/termux-app).
- Node.js.
- Android Platform Tools ("adb").
- Python for the wireless service-discovery helper.
- An Android device with Wireless Debugging enabled for wireless ADB connections.

Some wireless discovery and background features require additional setup. See the notes below.

Installation

1. Install the required packages

Open Termux and run:

pkg update
pkg upgrade
pkg install git nodejs android-tools python

2. Download ShuX

Clone the repository:

git clone https://github.com/yonukitube/ShuX.git
cd ShuX

3. Start ShuX

Run:

node shux.js

ShuX starts its web interface automatically.

Open the following address in your Android browser:

http://127.0.0.1:5600

Keep the Termux process running while using ShuX.

Connecting to an Android Device

1. Open Android Settings.
2. Enable Developer Options if they are not already enabled.
3. Open Wireless debugging.
4. Keep Wireless Debugging enabled.
5. Use the ShuX interface to reconnect or pair with the device when prompted.

The ADB connection must be authorized before ShuX can perform device operations.

Wireless discovery requirement

The current source expects a discovery helper at:

~/src/android-adb-helpers/bin/adb-mdns-discover

The helper must be installed and executable for the automatic wireless service-discovery workflow to work. It is not included in the ShuX repository.

Using ShuX with Compatible Applications

ShuX exposes a local HTTP API for applications that have been specifically programmed to integrate with it.

The API listens on:

http://127.0.0.1:8765

It is bound to the local loopback interface and is not intended to be a publicly accessible remote server.

API authentication

On its first launch, ShuX generates an API token and stores it in:

~/.shux-api-token

API requests must include this HTTP header:

Authorization: Bearer YOUR_API_TOKEN

Replace "YOUR_API_TOKEN" with the actual token obtained through a secure, local configuration process.

Never publish your API token, commit it to Git, or include a personal token in a publicly distributed application.

Supported application actions

The application-request API currently supports these actions:

Action| Description
"get_android_version"| Retrieve the Android version.
"get_device_identity"| Retrieve the output of the ADB "id" command.
"list_devices"| List devices visible to ADB.

Other actions are rejected unless explicitly implemented and allowed by ShuX.

Example: Request the Android version

A compatible application can send an authenticated HTTP POST request to:

http://127.0.0.1:8765/request

Example JSON body:

{
  "app": "Example App",
  "action": "get_android_version"
}

The request must include:

Content-Type: application/json
Authorization: Bearer YOUR_API_TOKEN

For example, an application using JavaScript can send:

const response = await fetch(
  "http://127.0.0.1:8765/request",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({
      app: "Example App",
      action: "get_android_version"
    })
  }
);

const result = await response.json();
console.log(result);

Here, "token" must be supplied securely by the application's local integration configuration. Do not hard-code a personal ShuX token into an APK distributed to other people.

The application must also have permission to make local HTTP requests under its Android networking configuration.

Application policies

ShuX supports four application policies:

- Ask Every Time: Keep requests pending for user approval.
- Always Allow: Automatically execute supported actions.
- Always Reject: Reject requests automatically.
- Disabled: Reject requests from the application.

Choose the appropriate policy in the ShuX dashboard. Automatically allowing requests should be reserved for applications you trust.

Security Notes

- ShuX is intended for local use on the Android device running Termux.
- Keep the API token private.
- Do not expose the local API through an external network without a separate, properly designed security layer.
- Only the explicitly supported application actions are available through the request API.
- Review application policies before enabling automatic execution.
- Public repository files should never contain private tokens, credentials, or personal configuration files.

Troubleshooting

The dashboard does not open

Make sure ShuX is running in Termux, then open:

http://127.0.0.1:5600

The API does not respond

Check whether ShuX is running and whether port "8765" is available.

ADB cannot find the device

Check that Wireless Debugging is enabled and that the device is paired and authorized.

Automatic pairing or reconnection fails

Verify that the required wireless discovery helper exists at the path documented above and is executable.

Contributing

Contributions, bug reports, and suggestions are welcome.

If you want to extend ShuX, review the existing API and its allowed-action checks before adding new functionality.

License

Check the repository's "LICENSE" file for the applicable license terms.
