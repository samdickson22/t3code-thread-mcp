# Global MCP acceptance

Tested September 16, 2026 with the packaged, globally installed CLI and real T3 servers. No parent/source thread was configured for global-mode tests.

## Installation and routing

`npm pack`, followed by `npm install -g` of that tarball, installed the `t3code-thread-mcp` executable. A real MCP SDK client launched that executable using only `T3_URL` and `T3_ACCESS_TOKEN`. Tool discovery, project discovery, the actual provider/model catalog, project/thread creation, and deletion of the disposable thread passed against released T3 0.0.40 and 0.0.42. [Install evidence](test/evidence/global-install-evidence.json).

A second configuration contained two named environments, each with its own server and database. The client created a project and a thread in each environment without an existing parent. These environments ran on one Mac; this proves multi-server routing, not a test between two physical computers. Remote connections use the same routing with HTTPS and an authorized token for each server.

## Actual agents communicating

An Astra thread on environment A used the global MCP to discover both environments and projects, create a Fable thread in a project on B, and send it work. Fable used the MCP itself to send `REMOTE_FABLE cobalt-lake-631` to Astra on A. Astra waited, read the worker, and returned `GLOBAL_CROSS_ENV_PASSED` with the created thread ID.

The models were `gpt-6-astra` with low reasoning and Claude Fable 5.1 with low effort (`claude-fable-5-1`, the current canonical provider slug). MCP registration was configured in each isolated server's provider launch settings. Installing a binary alone does not register it with a provider.

Both conversations were opened and inspected through browser computer use. [Astra screenshot](test/evidence/astra-cross-env.png), [Fable screenshot](test/evidence/fable-cross-env.png), and [messages and tool calls](test/evidence/cross-environment.json). The initial Astra launch failed because the test fixture's TOML arguments were incorrectly shell-quoted; correcting those arguments allowed the same test thread to run.

After the final review, both provider sessions were stopped and their MCP registration was changed to the globally installed executable from the final package. The repeated exchange returned `GLOBAL_INSTALL_FABLE_REPLY` from Fable and `GLOBAL_INSTALL_E2E_PASSED` from Astra. [Final package evidence](test/evidence/final-global-package.json) records the package checksum and tool calls; [the browser screenshot](test/evidence/final-global-package.png) shows the result.

## Lifecycle and limitations

The real Fable conversation passed rename, pin, settle, archive discovery, unarchive, history read, revival with remembered context, and unpin. Snooze and unsnooze also passed against the live server. The recall prompt did not contain the marker's value. [Lifecycle evidence](test/evidence/lifecycle-evidence.json) and [the restored conversation in the browser](test/evidence/fable-lifecycle.png).

This test caught and removed an incorrect archived-history fallback: T3's full snapshot contains archived thread metadata but omits its messages. The MCP now returns an explicit instruction to unarchive before reading, instead of claiming an empty conversation. Restoring the thread preserved its original messages.

This is not full Codex app feature parity. T3's public API does not expose equivalent conversation forks, host-to-host session handoff, or archived-history reads. The MCP does not pretend a new thread with pasted text is a native fork. Existing-thread provider migration also remains subject to T3's provider restrictions.
