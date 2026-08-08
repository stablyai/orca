import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  REMOTE_SERVER_UPDATE_CAPABILITY,
  RUNTIME_CAPABILITIES,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from './protocol-version'

/**
 * One-line agent-readable semantics for each runtime capability flag advertised
 * by `orca status --json` (#13202). Unknown/future flags are omitted.
 */
export const RUNTIME_CAPABILITY_DOCS: Readonly<Record<string, string>> = {
  'runtime.status.compat.v1':
    'Host advertises protocol compatibility fields on status (protocol version bounds).',
  'runtime.environments.v1':
    'Host supports remote environment inventory (environment list/show/add/rm RPCs).',
  [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]:
    'Paired clients may open the shared remote-control channel for multi-client coordination.',
  [ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]:
    'Orchestration can place workers on connected Orca servers (federated worker-start).',
  [ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY]:
    'Federated workers exchange control mail (stop/observe) across servers.',
  [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]:
    'worker-start accepts per-invocation model/effort launch preferences.',
  [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]:
    'Host speaks the current orchestration contract (Runs/Tasks/Dispatches/worker_*).',
  'browser.screencast.v1':
    'Host can create and stream browser pages (desktop webview or headless offscreen).',
  [BROWSER_HEADLESS_RUNTIME_CAPABILITY]:
    'Host owns browser pages with no desktop renderer (headless serve); do not fall back to local tabs.',
  [BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY]:
    'Host can proceed past certificate errors for hosted browser pages (Proceed Anyway).',
  'terminal.binary-stream.v1':
    'Terminal I/O uses binary stream framing (required for modern PTY consumers).',
  'terminal.multiplex.v1': 'Multiple clients may attach to the same terminal stream.',
  'workspace-ports.v1': 'Host exposes workspace port scanning / port-forward inventory.',
  'mobile.tasks.v1': 'Host serves the mobile tasks surface over runtime RPC.',
  [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]:
    'Project host setup RPCs (setup-create/clone/import) are available.',
  [TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY]:
    'Worktrees can carry task-source context (GitHub/Linear/Jira provenance on create).',
  [WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY]:
    'Workspaces can bind orchestration Run context for supervised work.',
  [WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY]:
    'Worktrees can store linked work-item context (issue/PR metadata).',
  [FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY]:
    'Folder workspaces report path/status health separate from git worktrees.',
  [LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY]:
    'Linear issue lists support attribute filters over RPC.',
  [AI_VAULT_RUNTIME_CAPABILITY]:
    'Agent Session History (aiVault.listSessions) is available on this host.',
  [TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY]:
    'terminal.send accepts inputKind for xterm query replies without taking the floor.',
  [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY]:
    'Host can park paired terminals and return bounded scrollback for lossless reveal.',
  [TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY]:
    'Host supports Quick Commands / agentPrompt on terminal create and settings RPCs.',
  [WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]:
    'worktree.create accepts clientMutationId for safe cutover retries.',
  [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]:
    'terminal.create accepts clientMutationId and can reconcile after a lost reply.',
  [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY]:
    'Clients can publish session-tab close intents over shared remote control.',
  [AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY]:
    'Host publishes agent-session boundary events for multi-client session ownership.',
  [REMOTE_SERVER_UPDATE_CAPABILITY]:
    'Paired client may drive remote Orca server updates (updater.remote-control).',
  [AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY]:
    'Host-authoritative agent session resume/attach path is available.',
  [AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY]:
    'OMP (OpenCode multi-provider) sessions support the host resume path.',
  [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]:
    'File mutation RPCs accept ownership fences; older hosts strip them.',
  [ACCOUNT_IMPORT_RUNTIME_CAPABILITY]:
    'Host can import Claude/Codex credentials from the host environment into managed accounts.',
  [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY]: 'Host supports Codex reset-credit account operations.'
} as const

export function describeRuntimeCapabilities(
  capabilities: readonly string[] | null | undefined
): Record<string, string> {
  const docs: Record<string, string> = {}
  for (const name of capabilities ?? []) {
    const doc = RUNTIME_CAPABILITY_DOCS[name]
    if (doc) {
      docs[name] = doc
    }
  }
  return docs
}

/** Every static capability in RUNTIME_CAPABILITIES must have a doc entry. */
export function listUndocumentedRuntimeCapabilities(): RuntimeCapability[] {
  return RUNTIME_CAPABILITIES.filter((name) => !RUNTIME_CAPABILITY_DOCS[name])
}
