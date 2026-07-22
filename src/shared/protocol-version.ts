// Why: declares the Orca runtime RPC compatibility contract. Desktop,
// headless server, CLI, and mobile builds may drift in app version, but
// they must agree on this protocol range before runtime RPCs are allowed.
//
// Bump RUNTIME_PROTOCOL_VERSION when:
//   - You remove an RPC method or required parameter that clients use.
//   - You change the meaning (units, nullability) of an existing field
//     clients read.
//   - You change encrypted framing, terminal stream framing, or auth.
// Do NOT bump for:
//   - Adding new RPC methods.
//   - Adding new optional fields on existing methods.
//   - Adding new ignorable event types.
//
// Bump MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION when a runtime server must
// refuse older clients. Bump MIN_COMPATIBLE_RUNTIME_SERVER_VERSION when
// this client build requires a newer server. Exact app-version equality is
// never required; these numbers define the supported compatibility window.

export const RUNTIME_PROTOCOL_VERSION = 3
export const MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2

export const PROJECT_HOST_SETUP_RUNTIME_CAPABILITY = 'project-host-setup.v1' as const
export const TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY = 'task-source-context.v1' as const
export const WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY = 'workspace-run-context.v1' as const
export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY =
  'linear.issue-attribute-filter.v1' as const
// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const

export const RUNTIME_CAPABILITIES = [
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  'browser.screencast.v1',
  'terminal.binary-stream.v1',
  'terminal.multiplex.v1',
  'workspace-ports.v1',
  'mobile.tasks.v1',
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
