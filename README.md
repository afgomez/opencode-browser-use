# OpenCode browser-use

Local OpenCode V2 server plugin. Owns a private, pinned `chrome-devtools-mcp`
subprocess and a dedicated regular Google Chrome instance. No Pi dependency,
standalone daemon, global MCP installation, or browser download.

## Setup

Requires Node 20.19+, 22.12+, or 23+ and regular Google Chrome. Dependencies
are already installed here. To reinstall reproducibly:

```sh
npm ci --ignore-scripts
```

This package lives at `~/code/opencode-browser-use` and is explicitly registered
in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/afgomez/code/opencode-browser-use"]
}
```

Keep other existing plugin entries when adding this registration. Do not configure
a separate `browser` MCP server: the upstream connection is private.
Chrome starts only on the first browser operation, not during plugin setup.

## Tools

Tools use the `browser_use` namespace (effective names such as
`browser_use_new_page`), avoiding collisions with OpenCode's built-in desktop
browser tools.
In Code Mode, use the tool names reported by OpenCode's tool catalog.

1. `new_page({url})` creates a background tab and returns a session-owned
   **string** `pageId` handle.
2. `take_snapshot({pageId})` reads the accessibility tree, including element UIDs.
3. Use `click`, `fill`, `fill_form`, `press_key`, `navigate_page`,
   `evaluate_script`, `take_screenshot`, or the other scoped tools with that handle.
4. `list_pages({})` lists **only your session's tabs**. `status({})` reports the
   browser/lease/login state without starting Chrome.
5. `close_page({pageId})` closes one owned tab. `release({})` closes all of your
   tabs and releases your lease; other sessions keep running.

Every page operation requires an owned handle, even reads. Numeric upstream
page IDs, arbitrary Chrome target IDs, and model-supplied session IDs are not
accepted. `select_page` validates a handle but changes no shared selection.
Results use filtered structured JSON; screenshots remain image attachments.

The reviewed allowlist includes navigation, input, snapshots, screenshots,
page JavaScript, console/network inspection, CSS inspection, and page emulation.
Browser-wide extension, PWA, service-worker, performance-tracing, and memory
tools are deliberately not exposed. Newly added upstream tools are not
automatically exposed. Human-created and popup tabs are **not adopted**; a
human can still use popups during the login handoff.

## Headed inspection

```js
switch_mode({ mode: "headed" })
switch_mode({ mode: "headless" })
```

`switch_mode` changes visibility without pausing automation: you can watch the
agent work in headed mode. The change applies to the one shared Chrome process,
so every session's owned tabs are reloaded. HTTP(S) URLs, persistent cookies, and
page handles survive; unsaved page state, navigation history, and snapshot UIDs
do not. Always take fresh snapshots afterward. The calling session's first owned
tab is activated when switching to headed mode; other sessions' tabs are never
selected for it.

Requesting the already-selected mode is a no-op and does not restart Chrome.
Requesting headless before Chrome has started does not start it. Switching to
headed can start Chrome without first launching it headless. `status` reports
`mode` (`headed` or `headless`) separately from `paused`.

Mode switches drain the shared operation queue before restarting. A failed
restart pauses automation rather than exposing partly restored state; retry
`switch_mode` to recover. A mode switch cannot bypass an active human-login
pause. Use `login_start` / `login_finish` when the agent must stop interacting
while you sign in. Login completion still returns Chrome to headless mode.
Idle shutdown resets the default to headless for the next browser launch.

## Human login

Get user approval before starting. Then:

1. `login_start({pageId})` drains pending calls, pauses **all sessions**, and
   restarts the shared profile in visible Chrome. The requested tab is activated.
2. The human completes authentication in Chrome. Do not send passwords through
   chat or browser tools. Wait for the human to confirm completion.
3. `login_finish({})`, from the initiating session, restarts Chrome headless and
   resumes other sessions. Authentication cookies/storage persist.

**Restarts reload every owned HTTP(S) URL. They lose unsaved form state,
in-memory JavaScript, sessionStorage, navigation history, and old snapshot
UIDs.** Page handles survive a coordinated restart, but take fresh snapshots.
Non-HTTP(S) pages return to a blank page rather than replaying scripts/files.
Unknown tabs are not restored by the plugin. Chrome itself may restore tabs,
but those remain unowned and invisible to the tools.

Login automatically returns headless after ten minutes; activity in Chrome
does not extend that deadline. Only the initiating session can finish it early.
A failed restart stays paused and can be retried with `login_finish`.

Tools check the `browser_use` permission action with their operation name as
the resource, except `switch_mode`, which uses `switch_mode.headed` or
`switch_mode.headless`. The global configuration allows routine operations but asks for
`login_start` because it begins a disruptive shared-profile handoff. `login_finish`
needs no additional permission prompt, but the agent must still wait for the
human to confirm they are done. It also asks for `switch_mode.headed`, because
opening a visible browser can steal focus and reloads all sessions' tabs.
Returning to headless does not require an extra prompt. Keep these exceptions
unless you explicitly want unattended transitions. Specific rules must follow
the broad `*` rule because the last matching rule wins.

## Lifecycle and concurrency

- One manager per profile per OpenCode **process**, retained in a versioned
  `globalThis` registry across per-location instances and module reloads.
  Compatible additive reloads update its implementation without discarding live
  leases, page handles, or the shared serialization queue.
- One private MCP connection, with all browser and lifecycle calls serialized.
  This favors correctness over parallel browser throughput in this first version.
- Stable Chrome tab target identities are checked and mapped to private MCP
  page IDs. MCP reconnection never trusts old numeric indexes or retries actions.
  The pinned upstream interoperability tool `get_tab_id` is used only internally.
- Each session holds a renewable lease. Every browser operation renews it.
  Explicit release, session deletion, or 30 minutes without browser-tool activity
  closes that session's tabs. Long pauses may therefore require opening new tabs.
- With no leases, Chrome exits after a one-minute idle grace period.
- Plugin unload has a 30-second grace period so reloads do not immediately
  discard active tabs. Other loaded locations retain the shared manager.
- A heartbeat-backed exclusive profile lock prevents other services from using
  this profile. Cross-service sharing is intentionally unsupported. After an
  abrupt service crash, wait up to 30 seconds for the stale lock to expire.
- A surviving advertised Chrome is verified against its exact profile, closed,
  and relaunched on recovery. Cookies persist, but ownership/handles do not
  survive a service or browser crash. Unknown tabs are never claimed.
- An already running unmanaged Chrome holding this profile is reported as a
  conflict, not killed. Never delete Chrome's `SingletonLock` to work around it.

## Options

To override defaults, configure this same plugin directory using the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/Users/afgomez/code/opencode-browser-use",
    "options": {
      "profileDirectory": "~/.cache/opencode/browser_use/chrome-profile",
      "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "nodePath": "node",
      "idleTimeoutMs": 60000,
      "leaseTimeoutMs": 1800000,
      "loginTimeoutMs": 600000,
      "unloadGraceMs": 30000
    }
  }],
  "permissions": [
    { "action": "browser_use", "resource": "*", "effect": "allow" },
    { "action": "browser_use", "resource": "login_start", "effect": "ask" },
    { "action": "browser_use", "resource": "switch_mode.headed", "effect": "ask" }
  ]
}
```

All locations sharing a profile must use identical options. Profile and Chrome
paths must be absolute (`~/` is accepted). On Linux/Windows the default Chrome
executable is the standard system installation path; override it as needed.
The default profile is `~/.cache/opencode/browser_use/chrome-profile`, dedicated
to this plugin rather than shared with independent Chrome DevTools MCP clients.
The previous `~/.cache/chrome-devtools-mcp/chrome-profile` is left untouched and
is not automatically copied or migrated. A fresh OpenCode profile requires its
own login; authentication then persists in this new directory.

The plugin's permission action is `browser_use`, not `browser`.
OpenCode reserves `browser` for its separate desktop browser; its availability
rules must not affect this plugin.

Local file arguments resolve relative to the caller's OpenCode location. MCP
filesystem roots are restricted to that workspace and the OS temporary directory.
Sensitive network headers are redacted; upstream MCP usage telemetry and CrUX
requests are disabled. This does not disable Chrome's own network services.

## Boundaries

Tab ownership prevents accidental cross-session interference; it is **not a
security sandbox**. Sessions share profile cookies, localStorage, accounts, and
browser process authority. Page JavaScript can use the authenticated profile;
same-origin windows may interact. Unrestricted shell access can bypass a local
debugging endpoint. Never use this profile for mutually untrusted agents.

The debugging endpoint binds to loopback and uses an ephemeral port. Profile
metadata is private to the local user. No endpoint is exposed as an OpenCode
tool or independent configured MCP connection.

## Development

```sh
npm run typecheck
npm test
npm run test:integration
npm run test:opencode
```

Integration tests use disposable profiles, a local HTTP server, and regular
Chrome. They verify cookie persistence, scope, stable handles, profile contention,
and abrupt-process recovery. Their mode/login transitions are deliberately forced
headless to avoid stealing focus. Visible inspection and third-party AuthKit
login remain manual checks; the tests do not authenticate to any real account.
