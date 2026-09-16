import peerTools from "./tools.json" with { type: "json" };
const str = { type: "string", minLength: 1 };
const bool = { type: "boolean" };
const source = {
  type: "object",
  properties: { environmentId: str, threadId: str },
  required: ["environmentId", "threadId"],
  additionalProperties: false,
};
const route = {
  environmentId: {
    ...str,
    description:
      "Configured computer/environment ID. Required unless a default environment is configured.",
  },
};
function tool(
  name,
  description,
  properties,
  required = [],
  readOnly = false,
  destructive = false,
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...route, ...properties },
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
  };
}
const target = { threadId: str, commandId: str };
export const globalTools = peerTools.map((t) => {
  const copy = structuredClone(t);
  copy.inputSchema.properties = { ...route, ...copy.inputSchema.properties };
  copy.description = copy.description
    .replaceAll("peer thread", "thread")
    .replaceAll("in this project", "on the selected environment");
  return copy;
});
const named = (n) => globalTools.find((t) => t.name === n);
Object.assign(named("create_thread").inputSchema.properties, {
  projectId: str,
  runtimeMode: {
    enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  },
  interactionMode: { enum: ["default", "plan"] },
});
named("create_thread").inputSchema.required = [
  "title",
  "projectId",
  "modelSelection",
];
named("create_thread").description =
  "Create an empty persistent thread in any project on a configured environment. Requires explicit project and model; defaults to approval-required permissions. No parent is needed. Does not copy history.";
Object.assign(named("list_threads").inputSchema.properties, {
  projectId: str,
  includeArchived: bool,
});
named("list_threads").description =
  "List threads across projects on the selected environment. Optionally filter projectId or include archived threads.";
Object.assign(named("send_message_to_thread").inputSchema.properties, {
  source,
});
named("send_message_to_thread").description =
  "Send a message to any thread on the selected environment, reviving settled work. Optional source is verified and adds cross-environment reply instructions. Without source the message is sent without invented thread attribution.";
named(
  "wait_threads",
).inputSchema.properties.targets.items.properties.environmentId = str;
named("wait_threads").description =
  "Wait for any of up to eight threads across configured environments to finish or need attention. Supply each target environmentId and last cursor; timeout is at most 60 seconds. Returns observed threads plus unavailable references for failed or cancelled reads. A ready thread cancels outstanding reads; zero wait allows one network observation of at most one second.";
globalTools.push(
  tool(
    "list_environments",
    "List configured computers and routing IDs. Does not expose credentials.",
    {},
    [],
    true,
  ),
  tool(
    "list_projects",
    "List projects and their workspace roots on the selected environment.",
    {},
    [],
    true,
  ),
  tool(
    "list_providers",
    "Discover configured provider instances, authentication status and available model catalog on the selected environment.",
    {},
    [],
    true,
  ),
  tool(
    "list_archived_threads",
    "List archived threads on the selected environment.",
    {
      projectId: str,
      limit: { type: "integer", minimum: 1, maximum: 100 },
      beforeThreadId: str,
    },
    [],
    true,
  ),
  tool(
    "set_thread_title",
    "Rename a persistent thread.",
    { ...target, title: str },
    ["threadId", "title"],
  ),
  tool(
    "set_thread_archived",
    "Archive or unarchive a persistent thread.",
    { ...target, archived: bool },
    ["threadId", "archived"],
    false,
    true,
  ),
  tool(
    "set_thread_pinned",
    "Pin or unpin a persistent thread.",
    { ...target, pinned: bool },
    ["threadId", "pinned"],
  ),
  tool(
    "set_thread_snoozed",
    "Snooze a thread until an ISO timestamp, or clear its snooze with null.",
    {
      ...target,
      snoozedUntil: { type: ["string", "null"], format: "date-time" },
    },
    ["threadId", "snoozedUntil"],
  ),
  tool(
    "delete_thread",
    "Permanently delete a thread and its history.",
    target,
    ["threadId"],
    false,
    true,
  ),
  tool(
    "stop_thread_session",
    "Stop the provider session while retaining thread history.",
    target,
    ["threadId"],
    false,
    true,
  ),
  tool(
    "respond_to_approval",
    "Answer a pending approval by its request ID.",
    {
      ...target,
      requestId: str,
      decision: {
        enum: [
          "accept",
          "acceptForSession",
          "acceptAlways",
          "decline",
          "cancel",
        ],
      },
    },
    ["threadId", "requestId", "decision"],
    false,
    true,
  ),
  tool(
    "respond_to_user_input",
    "Answer a pending user input request.",
    {
      ...target,
      requestId: str,
      answers: { type: "object", additionalProperties: true },
    },
    ["threadId", "requestId", "answers"],
  ),
  tool(
    "dismiss_user_input",
    "Dismiss an asynchronous user input request.",
    { ...target, requestId: str },
    ["threadId", "requestId"],
    false,
    true,
  ),
  tool(
    "create_project",
    "Create a project on the selected computer using an absolute workspace path on that computer.",
    {
      commandId: str,
      title: str,
      workspaceRoot: str,
      createWorkspaceRootIfMissing: bool,
    },
    ["title", "workspaceRoot"],
  ),
);
