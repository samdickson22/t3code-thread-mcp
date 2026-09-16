# T3 Code thread MCP

Manage persistent T3 threads across projects and computers from one globally installed MCP server. **No parent thread ID is required.** Each computer needs a running T3 server and an authorized connection. Threads remain visible in T3's desktop, web, and mobile clients.

## Install globally

Requires Node 22 or later. Desktop discovery requires the companion T3 desktop build linked below. Direct connections were tested with released T3 0.0.40 and 0.0.42.

```sh
npm install -g https://github.com/samdickson22/t3code-thread-mcp/releases/download/v0.3.0/t3code-thread-mcp-0.3.0.tgz
t3code-thread-mcp --help
```

This package is distributed through GitHub releases; it is not currently published to the npm registry. You can also clone this repository, run `npm ci`, and launch `node src/cli.js`.

## Connect computers

### Reuse the T3 desktop connection manager

On macOS or Linux, with a T3 desktop build that supports the connection bridge, run:

```sh
t3code-thread-mcp
```

Register that command with your MCP host. It uses the running desktop app's
computer list and authenticated connections, including T3 Connect and SSH. Add
or remove computers in T3's **Settings → Connections**; the MCP refreshes that
list on each call. No parent ID, server URL, or access token is required.

Desktop discovery is the default when no direct connection is configured. It requires [the companion T3 desktop change](https://github.com/pingdotgg/t3code/pull/12148).
Windows desktop mode is disabled until its named-pipe endpoint can be authenticated; use direct connection configuration on Windows. The MCP runs on the same computer as the desktop app. Agents on another computer
need access to a bridge-enabled desktop there; this does not automatically
install tools into remote provider sessions.

For a custom T3 home, use `--desktop-state-dir /path/to/t3-home/userdata`.
The app must remain open. Closing it rejects new operations; agent work already
accepted by a server may continue. Connection credentials stay inside T3. The
existing direct-connection and legacy scoped modes below are unchanged.

### Configure direct connections

For one computer, supply `T3_URL` and `T3_ACCESS_TOKEN` to the MCP process through your host's environment or secret manager. Use HTTPS remotely; loopback HTTP is supported. Obtain the access token through T3's normal pairing/token-exchange flow. When it expires, refresh it and restart the MCP process.

For several computers, create `~/.config/t3code-thread-mcp/config.json`:

```json
{
  "environments": [
    {
      "id": "desktop",
      "label": "My desktop",
      "url": "http://127.0.0.1:3773",
      "tokenEnv": "T3_DESKTOP_TOKEN"
    },
    {
      "id": "server",
      "label": "Remote server",
      "url": "https://your-t3-server.example",
      "tokenEnv": "T3_SERVER_TOKEN"
    }
  ]
}
```

Use your actual server addresses and supply the named token variables to the MCP process. The file contains variable names, not secret values. Keep environment IDs consistent between agents that will reply to each other. This does not discover arbitrary computers or bypass T3 authentication. For T3 Connect, use a supported reachable server endpoint; a UI connection label is not an API URL.

Pass `--config /absolute/path/config.json` or set `T3_MCP_CONFIG` to use a different file. With multiple environments, calls select `environmentId`; an optional top-level `defaultEnvironment` supplies a default. A single configured environment is selected automatically. `T3_URL` takes precedence over the default file.

**Upgrading from 0.1.x:** remove `T3_SOURCE_THREAD_ID` from the MCP configuration to use global mode. An explicit source ID plus `T3_URL` retains legacy project scope, even when `T3_MCP_CONFIG` is inherited. An explicit `--config` selects the global configuration.

## Register with your agents

Installing the executable and registering an MCP server are separate steps. Register once at user scope on each computer/provider home where agents should have these tools. Newly started T3 provider sessions can then load that registration. Existing sessions may need to restart.

Codex user configuration (`~/.codex/config.toml`):

```toml
[mcp_servers.t3_threads]
command = "/absolute/path/to/t3code-thread-mcp"
```

Find the executable path with `command -v t3code-thread-mcp`. No arguments or token variables are needed for desktop discovery. For direct connections, add `--config` arguments and forward the required token variable names through `env_vars`.

Claude Code user registration:

```sh
claude mcp add --scope user t3_threads -- /absolute/path/to/t3code-thread-mcp
```

For direct connections, supply token variables in the environment that launches Claude/T3. If T3 uses a custom Codex or Claude home, register there. Alternatively, configure the MCP through T3's provider launch arguments. The [live validation](GLOBAL-E2E.md) exercised both providers using per-environment launch settings.

For other MCP hosts, launch the same executable with stdio transport, optional `--config` arguments, and the required environment variables. The MCP does not print credentials or write logs to stdout.

## Global tools

| Tools | Behavior |
| --- | --- |
| `list_environments` | Discover configured computer IDs. |
| `list_projects`, `create_project` | Discover or create projects on a selected computer. Workspace paths belong to that computer. |
| `list_providers` | Read the server's actual installed providers, authentication status, and model catalog. |
| `create_thread` | Create a persistent thread in any project. Requires `projectId`, title, and model selection. Defaults to approval-required permissions; no parent is needed. |
| `list_threads`, `list_archived_threads` | List threads across projects with optional project filtering and pagination. |
| `read_thread` | Read active conversation history and pending requests. Message text is capped at 8,000 characters with truncation indicated. Restore archived threads before reading their history. |
| `send_message_to_thread` | Send or queue work and revive settled threads. Optional `source: { environmentId, threadId }` adds a sender reference and reply routing after checking that the source thread exists. Without it, the message has no invented sender. |
| `wait_threads` | Wait for up to eight threads across environments, using cursors to suppress repeated results. Unobserved/unavailable targets are reported separately. A zero wait allows one bounded network observation. |
| `interrupt_thread`, `stop_thread_session` | Interrupt work or stop its provider session while retaining conversation history. |
| `set_thread_settled` | Settle or reactivate threads. T3 rejects settlement while work or blocking requests remain. |
| `set_thread_title`, `set_thread_pinned`, `set_thread_snoozed` | Rename, pin/unpin, or snooze/unsnooze. Use `snoozedUntil: null` to clear a snooze. |
| `set_thread_archived`, `delete_thread` | Archive/restore or permanently delete a thread. |
| `respond_to_approval`, `respond_to_user_input`, `dismiss_user_input` | Manage explicit pending requests by request ID. |

Start with `list_environments`, then `list_projects` and `list_providers`. For example:

```json
{
  "name": "create_thread",
  "arguments": {
    "environmentId": "server",
    "projectId": "project-id-from-list-projects",
    "title": "Investigate issue 123",
    "commandId": "issue-123-create",
    "modelSelection": {
      "instanceId": "codex",
      "model": "gpt-6-astra",
      "options": [{ "id": "reasoningEffort", "value": "low" }]
    }
  }
}
```

Send work using the returned thread ID and the same environment ID. Select a Claude model from that environment's provider catalog; the current Fable 5.1 canonical slug is `claude-fable-5-1` with instance `claudeAgent` and option `{ "id": "effort", "value": "low" }`.

Mutations accept an optional `commandId`. Persist it before dispatch and reuse it only for the identical operation and arguments. T3 stores receipts, including rejected commands. A receipt means accepted, not completed; use read/wait to inspect execution. Global retry identities include routing, operation, project/target, and optional source. Keep these stable across retries.

## Legacy compatibility and parity limits

Setting `T3_SOURCE_THREAD_ID` retains the original seven project-scoped tools, schemas, defaults, sender attribution, and retry behavior. Agentdoc's existing scoped configuration continues to work. `src/tools.json` remains generated from the [native T3 peer-tools PR](https://github.com/pingdotgg/t3code/pull/11303); global mode adds routing and management tools beyond that PR's scoped contract.

This release does **not** claim full Codex app feature parity. T3's public API does not expose equivalent conversation forks or host-to-host session handoff. It also withholds archived message history until the thread is restored. The MCP reports that limitation instead of returning false empty history or silently unarchiving it. Creating a new thread does not copy history, clone a provider session, or create a worktree. Changing an existing thread's provider driver may be rejected by T3; threads owned by different providers can communicate across environments.

The HTTP and WebSocket routes are existing T3 application APIs, not a guaranteed stable third-party protocol. This integration is independent of Agentdoc or any task board.

## Validation

```sh
npm test
npm run check
```

Tests cover the real MCP stdio boundary, global installation/configuration, cross-project and cross-environment routing, legacy scope, retry identities, attention states, and unavailable hosts. [Browser screenshots and real-provider evidence](GLOBAL-E2E.md) show Astra-low creating Fable-low on another environment, Fable replying through its own MCP tools, and settlement/archive/restoration/revival with retained context.
