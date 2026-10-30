# OpenCode browser-use

Local OpenCode V2 server plugin using a private, pinned `chrome-devtools-mcp`
subprocess. Each session can use shared plugin Chrome, isolated plugin Chrome,
or attach to the user's running Chrome. No Pi dependency, standalone daemon,
global MCP installation, extension, or browser download.

## Setup

Requires Bun (tested with 1.4.0), Node 20.19+, 22.12+, or 23+, and regular
Google Chrome. Dependencies are already installed here. To reinstall reproducibly:

```sh
bun install --frozen-lockfile
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
Plugin-owned Chrome starts only on the first browser operation, not during plugin
setup. Attach mode never starts Chrome.

## Browser modes

Each new OpenCode session defaults to **Shared**. The user's selection persists
per session across service restarts; changing one session does not change the
default for new sessions. Only trusted user controls can switch modes, never
model tools. Switch with the sidebar settings dialog or:

```text
/browser-use
/browser-use mode
/browser-use mode shared
/browser-use mode isolated
/browser-use mode attach
```

`/browser-use` without arguments opens the same settings dialog as the sidebar.

Every actual change requires confirmation. Between Shared and Isolated, live
owned tabs are reopened in the destination before the originals are closed;
page handles stay the same, but snapshots and unsaved page state are lost. Only
HTTP(S) URLs are reopened; other schemes become blank tabs. Reopening URLs can
have server-side effects. Profiles, cookies, and authentication are not copied.
Switches to or from Attach close owned tabs without restoring them or their
handles. Other sessions' tabs are unaffected. Switching during login or recovery
is blocked. If a switch fails, cleanup is retried before later session operations;
an error can occur after the new mode was saved, so check the current mode.
If destination tabs are confirmed lost and the source tabs are intact, recovery
restores the source mode without reopening URLs. Uncertain storage or cleanup
failures retain both copies and require a retry. While recovery is incomplete,
login and visibility restarts of either affected browser are blocked, including
for other Shared sessions. Retry inspection or mode switching in the affected
session. Transfer recovery and page handles are in-memory only and do not survive
a service restart; profiles and the saved mode persist, but tabs cannot be
recovered through their old handles after restart.

- **Shared** uses the existing plugin-owned Chrome and persistent profile.
  Sessions share cookies and storage; tab ownership remains per session.
- **Isolated** gives each session a separate Chrome, MCP connection and
  persistent profile. Profiles survive inactivity and service restart, but are
  removed on session deletion, including after switching away. Idle browsers
  may stop without deleting their profiles. Deletion waits for a stale profile
  lock and stops a verified surviving plugin Chrome before removing its files;
  if this cannot be done safely, cleanup fails and is logged rather than deleting
  a profile in use.
- **Attach** attaches to running Chrome 144+ using its standard stable-channel
  user-data directory. Enable remote debugging at
  `chrome://inspect/#remote-debugging` and approve connection requests. The
  plugin does not launch Chrome, install an extension, or explicitly terminate
  the user's Chrome. It closes only tabs it created; closing the last tab may
  naturally cause Chrome to exit. Existing user and popup tabs are never adopted.
  This mode shares the user's cookies and other profile state. If attachment or
  consent is unavailable it fails, with no fallback to another browser.

Chrome may request approval separately for the plugin's metadata and MCP
connections. Attach-mode attachment requires a manual check in the user's actual
Chrome; it is not covered by the disposable-profile integration tests.

## Tools

Tools use the `browser_use` namespace (effective names such as
`browser_use_new_page`), avoiding collisions with OpenCode's built-in desktop
browser tools.
In Code Mode, use the tool names reported by OpenCode's tool catalog.
Browser guidance lives in the namespace and tool descriptions; the plugin does
not inject a separate instruction paragraph into session context.

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

## Sidebar

The terminal UI always shows a **Browser use** title and **Settings** button in
the session sidebar, including before Chrome starts and when there are no tabs.
Each tab entry shows its title and a muted URL, truncated to the available width.
Pages without a title show **Untitled**. The list follows the viewed session,
not the entire browser or its parent/subagent sessions.

The title-row **Settings** button opens a custom dialog showing mode and visibility
choices together. Use the mouse or arrow keys/Tab and Enter to choose. The
current mode and visibility appear beneath the title (for example, **Shared / Headless**); visibility
is hidden in Attach mode. Changes require confirmation; see [Browser modes](#browser-modes)
for tab transfers and [Headed inspection](#headed-inspection) for visibility changes.
Controls show a spinner
while applying a confirmed change and are disabled during login/recovery or
when the browser state cannot be read. Changing mode or visibility while the
browser is stopped configures future use; it never launches or attaches to Chrome.
Failed switches show an error toast. The confirmation authorizes these trusted
client controls, which do not evaluate agent permission rules; agent tools still
enforce those rules unchanged.

The list and settings refresh about once per second while mounted, including human title,
navigation, and close changes during headed inspection or login. Reads share
the browser operation queue, so a long-running tool can delay an update. Failed
reads clear stale entries, show **Browser connection unavailable; retrying…**,
and retry on the next poll. Switching sessions or
unmounting cancels the old reader and discards late responses.

Tab entries remain read-only: no links, focus switches, or close controls. Inspection never
starts/restarts Chrome, renews a session lease, or adopts unknown tabs. It reads
only target metadata over the private connection; login remains paused. If the
metadata socket disconnects while plugin-owned Chrome is still alive, inspection
reattaches to the exact same endpoint and retries that read once, without
reloading tabs or replaying browser actions.
The TUI part loads automatically with the existing plugin registration, with no
additional permission rules. Other clients can import the `./rpc` contract and
call `pages({ sessionID })` at the session's location; it returns `mode`,
`visibility` (null in Attach mode), and `paused` alongside only that session's owned `pageId`, `title`,
and `url` fields. `setVisibility({ sessionID, visibility })` is a trusted-client control:
it bypasses agent permission rules and relies on the UI's confirmation, while
using the same serialized lifecycle and login-pause restrictions as the browser
tools. The RPC itself does not prove a human confirmed; it is not an agent tool
or a security boundary against untrusted clients. Session IDs for this UI API come from the
client, never from model-supplied browser-tool inputs. `setMode` is likewise a
trusted-client control and must only be invoked after user confirmation.

## Headed inspection

Visibility is a user control, not an agent tool. Use the sidebar button or the
local TUI command in an open session:

```text
/browser-use visibility headed
/browser-use visibility headless
/browser-use visibility
```

Omit the visibility value to open a visibility-only picker; use `/browser-use`
without arguments for the sidebar's combined settings dialog. Invalid arguments show
usage rather than sending a prompt to the agent. The command works with the
sidebar hidden and before any tabs are opened. Actual changes require the same
confirmation as the sidebar, bypass agent permission rules, and share its busy
state/spinner.

Changing visibility does not pause automation: you can watch the
agent work in a visible window. It restarts the affected browser as described in
[Restart effects](#restart-effects). Attach mode has no visibility control.
The calling session's first owned
tab is activated when switching to headed visibility; other sessions' tabs are never
selected for it.

Requesting the already-selected visibility is a no-op and does not restart Chrome.
Changing visibility while Chrome is stopped only sets the next launch's
visibility, without starting Chrome or creating a session lease. The selection
survives sidebar polling and idle cleanup until Chrome is used. `status` reports
`mode` and `visibility` (`headed` or `headless`, null for Attach) separately from `paused`.

Visibility changes drain the affected browser's operation queue before restarting. A failed
restart pauses automation rather than exposing partly restored state; retry an
explicit `/browser-use visibility headless` or `headed` command to recover,
even if the requested visibility is already selected. A visibility change cannot bypass an active human-login
pause. Use `login_start` / `login_finish` when the agent must stop interacting
while you sign in. Login completion still returns Chrome to headless visibility.
Idle shutdown resets the default to headless for the next browser launch.

## Human login

Get user approval before starting. Then:

1. `login_start({pageId})` drains pending calls, pauses the affected browser,
   and restarts its profile in visible Chrome. Shared mode pauses all shared
   sessions; Isolated mode pauses only its session. The requested tab is activated.
2. The human completes authentication in Chrome. Do not send passwords through
   chat or browser tools. Wait for the human to confirm completion.
3. `login_finish({})`, from the initiating session, restarts Chrome headless and
   resumes the affected sessions. Authentication cookies/storage persist.

In Attach mode these calls do not restart or pause Chrome. Ask the user to log in
manually in their own Chrome and wait for confirmation before continuing.

Both login transitions have the [restart effects](#restart-effects) below.

Login automatically returns headless after ten minutes; activity in Chrome
does not extend that deadline. Only the initiating session can finish it early.
A failed restart stays paused and can be retried with `login_finish`.

Tools check the `browser_use` permission action with their operation name as
the resource. The global configuration allows routine operations but asks for
`login_start` because it begins a disruptive shared-profile handoff. `login_finish`
needs no additional permission prompt, but the agent must still wait for the
human to confirm they are done. Visibility is controlled only by the user through
the sidebar or command, not an agent tool or permission rule. Keep the login exception
unless you explicitly want unattended transitions. Specific rules must follow
the broad `*` rule because the last matching rule wins.

## Restart effects

Visibility changes and human-login transitions restart the affected plugin-owned
browser: all Shared sessions, or only the Isolated session.
**Restarts reload every owned HTTP(S) URL. They lose unsaved form state,
in-memory JavaScript, sessionStorage, navigation history, and old snapshot
UIDs.** Persistent cookies and page handles survive a coordinated restart, but
take fresh snapshots. Non-HTTP(S) pages return to a blank page rather than
replaying scripts/files. Unknown tabs are not restored by the plugin. Chrome
itself may restore tabs, but those remain unowned and invisible to the tools.

## Lifecycle and concurrency

- One manager per profile per OpenCode **process**, retained in a versioned
  `globalThis` registry across per-location instances and module reloads.
  Compatible additive reloads update its implementation without discarding live
  leases, page handles, or the shared serialization queue.
- One private MCP connection per active browser, with browser and lifecycle calls serialized.
  This favors correctness over parallel browser throughput in this first version.
- Stable Chrome tab target identities are checked and mapped to private MCP
  page IDs. MCP reconnection never trusts old numeric indexes or retries actions.
  The pinned upstream interoperability tool `get_tab_id` is used only internally.
- Each session holds a renewable lease. Every browser operation renews it.
  Explicit release, session deletion, or 30 minutes without browser-tool activity
  closes that session's tabs. Long pauses may therefore require opening new tabs.
- With no leases, plugin-owned Chrome exits after a one-minute idle grace period.
  User Chrome is disconnected, never explicitly closed.
- Plugin unload has a 30-second grace period so reloads do not immediately
  discard active tabs. Other loaded locations retain the shared manager.
  Once fully unloaded and stopped, the manager is removed from the registry so
  a later load can use different options for that profile without a service restart.
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
    { "action": "browser_use", "resource": "login_start", "effect": "ask" }
  ]
}
```

All locations sharing a profile must use identical options. Profile and Chrome
paths must be absolute (`~/` is accepted). On Linux/Windows the default Chrome
executable is the standard system installation path; override it as needed.
The default profile is `~/.cache/opencode/browser_use/chrome-profile`, dedicated
to this plugin rather than shared with independent Chrome DevTools MCP clients.

The plugin's permission action is `browser_use`, not `browser`.
OpenCode reserves `browser` for its separate desktop browser; its availability
rules must not affect this plugin.

Local file arguments resolve relative to the caller's OpenCode location. MCP
filesystem roots are restricted to that workspace and the OS temporary directory.
Sensitive network headers are redacted; upstream MCP usage telemetry and CrUX
requests are disabled. This does not disable Chrome's own network services.

## Boundaries

Tab ownership prevents accidental cross-session interference; it is **not a
security sandbox**. Shared-mode sessions share profile cookies, localStorage,
accounts, and browser process authority; Attach mode shares the user's profile.
Isolated profiles separate browser state but are not an OS security sandbox.
Page JavaScript can use the authenticated profile;
same-origin windows may interact. Unrestricted shell access can bypass a local
debugging endpoint. Never use this profile for mutually untrusted agents.

The debugging endpoint binds to loopback and uses an ephemeral port. Profile
metadata is private to the local user. No endpoint is exposed as an OpenCode
tool or independent configured MCP connection.

## Compatibility

- The registered TUI command ID remains `browser-use.visibility` for existing
  keybindings; its title and bare `/browser-use` action open browser settings.
- Hot reload migrates the legacy in-memory visibility field without restarting
  Chrome or discarding handles. Clients should use the current `setVisibility`
  RPC contract; state responses use `visibility`.
- Old `switch_mode.*` permission rules are no longer needed.
- The previous `~/.cache/chrome-devtools-mcp/chrome-profile` is left untouched
  and is not automatically copied or migrated. A fresh OpenCode profile requires
  its own login; authentication then persists in the configured profile directory.

## Development

```sh
bun run typecheck
bun run test
bun run test:integration
bun run test:opencode
bun run test:tui
```

Integration tests use disposable profiles, a local HTTP server, and regular
Chrome. They verify cookie persistence, scope, stable handles, profile contention,
and abrupt-process recovery. Their visibility/login transitions are deliberately forced
headless to avoid stealing focus. Visible inspection and third-party AuthKit
login remain manual checks; the tests do not authenticate to any real account.

TUI rendering tests require Bun and use the OpenTUI test renderer (no interactive
terminal needed). The OpenTUI/Solid development versions match the plugin SDK's
peers; `seroval` is overridden to a patched version because that Solid release
otherwise pins an older vulnerable serializer. OpenCode supplies the actual
TUI runtime when loading the plugin.
