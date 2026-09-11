# T3 Code thread MCP

Create, read, message, wait for, interrupt, and settle persistent T3 Code threads from an MCP client. Works with the existing HTTP API in T3 Code **0.0.40**, without modifying T3. Threads remain visible in its desktop, web, and mobile clients.

This server matches the native peer-thread tools proposed in the T3 Code PR. The tool names, input schemas, defaults, result fields, project scope, source attribution, and command retry IDs are the same. `src/tools.json` is generated from the native tools, and its sync check detects contract changes.

## Run

Requires Node 22 or later and a running T3 Code server.

```sh
git clone https://github.com/samdickson22/t3code-thread-mcp.git
cd t3code-thread-mcp
npm ci
node src/cli.js
```

Set these environment variables in the process that launches the MCP server:

| Variable              | Meaning                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3_URL`              | T3 server base URL. Use HTTPS for remote connections; loopback HTTP is supported.                                                                                         |
| `T3_ACCESS_TOKEN`     | Existing T3 bearer access token with read/write scopes, obtained through its normal pairing/token exchange flow. Supply through your host's secret environment mechanism. |
| `T3_SOURCE_THREAD_ID` | An existing, unarchived thread whose project scopes this server and whose identity is attached to outgoing messages.                                                      |

Configure your MCP host to launch `node` with the absolute path to `src/cli.js` as its argument, passing those environment variables. The transport is stdio. Logs never go to stdout; no credentials are printed. When an access token expires, obtain a new one through T3 and restart this process with the new token.

Each MCP instance has one source thread. Run separate instances with the corresponding source IDs when different agents need their own identities. This package does not automatically install itself into every provider session in an existing T3 installation. The native implementation handles that injection.

An external coordinator can use an empty source thread as its project anchor. That anchor does not have to run the coordinator. Use `replyToSource: false` when the coordinator watches worker completion itself, so the worker is not instructed to wake the anchor.

## Tools

| Tool                     | Behavior                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_thread`          | Creates an empty peer at the project root. Takes a title and optional model selection. Does not copy history or create a worktree.                                                                           |
| `list_threads`           | Lists peers, including settled threads, with ID-based pagination. Excludes archived threads.                                                                                                                 |
| `read_thread`            | Returns current state and paginated conversation messages. Omits attachments and tool output; caps each message at 8,000 characters and marks truncation.                                                    |
| `send_message_to_thread` | Sends a visible user follow-up with source attribution. Starts or queues work and revives settled threads. Optional model selection changes the model; T3 may reject changing an existing thread's provider. |
| `wait_threads`           | Waits for any of up to eight peers to finish or need attention. Defaults to 60 seconds. Return each thread's cursor on subsequent waits to suppress repeated notifications.                                  |
| `set_thread_settled`     | Settles or reactivates a peer. Running/queued work and blocking requests prevent settlement.                                                                                                                 |
| `interrupt_thread`       | Requests interruption while preserving the conversation.                                                                                                                                                     |

All targets must belong to the source thread's project on the configured server. The native server uses domain events for waits; this compatibility server polls the existing HTTP shell endpoint every 500 ms. Neither treats commentary alone as completion. Cursors are opaque and can change after an upgrade.

Mutations accept an optional `commandId`. Persist it before dispatch and reuse it only for an identical operation and arguments. IDs are scoped to the source thread. T3's stored command receipts prevent duplicate execution after a retry or process restart. Creation derives the thread ID from that command ID, so a retry returns the same thread. A command receipt means accepted, not that an agent has finished. Use read/wait to inspect execution.

For example, create a peer and then send it work:

```json
{
  "name": "create_thread",
  "arguments": {
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

Pass the returned `threadId` to `send_message_to_thread`. A Claude peer can use `{"instanceId":"claudeAgent","model":"claude-fable-5.1","options":[{"id":"effort","value":"low"}]}`. Provider instances and model access must already be configured in T3. In T3 0.0.40, an existing thread bound to Codex rejects a switch to the Claude driver. Create a peer on the other provider and exchange context through messages instead. The tools report the execution error and preserve existing history.

## Validation

```sh
npm test
npm run check
T3_NATIVE_CHECKOUT=/path/to/native-t3-branch node scripts/sync-native-contract.mjs --check
```

The stdio tests exercise a real MCP client, HTTP transport, scope checks, retries, null validation, history limits, and attention cursors. Native tests use the real SQLite orchestration engine and MCP consumer boundary, including restart and command receipt replay.

Live validation used unmodified T3 0.0.40, GPT-6 Astra with low reasoning, and Claude Fable 5.1. Separate source clients exchanged messages across both providers and settled/revived both threads with remembered history. The native branch was tested with the agents themselves calling peer tools, including Claude replying to Codex. Computer-use checks opened the persistent conversations through a real remote browser.

## Scope

This is a generic T3 integration, independent of any task board. A coordinator such as Agentdoc Teams can store returned thread references in its own documents and use these tools to delegate and resume work. Coordination policy and delivery back to that control agent belong to the coordinator.

The T3 HTTP routes are current application APIs, not a promised stable third-party protocol. This package is pinned by its compatibility tests to the version above. It does not promise exactly-once completion callbacks, import arbitrary transcripts, answer approvals, archive/delete threads, or move work between environments.
