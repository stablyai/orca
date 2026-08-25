import { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_DELETE_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from './skill-install-capability'
export { SKILL_INSTALL_RESULT_V2_CAPABILITY } from './skill-install-capability'

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
export const WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY =
  'worktree.linked-work-item-context.v1' as const
export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
export const ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY = 'orchestration.federation.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY =
  'orchestration.federation-control-mail.v1' as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY =
  'orchestration.federation-lifecycle-settlement.v1' as const
export const ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY =
  'orchestration.worker-stop-verdict.v1' as const
export const ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY =
  'orchestration.worker-launch-preferences.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION = 2 as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION = 3 as const
export const ORCHESTRATION_CONTRACT_VERSION = 1 as const
export const ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY = 'orchestration.contract.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY =
  'linear.issue-attribute-filter.v1' as const
// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Why: older hosts discard browser.tabCreate's page field, so clients may only
// treat a preallocated page ID as canonical when this is advertised.
export const BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY =
  'browser.tab-create-known-id.v1' as const
export const BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY = 'browser.clientHost.v1' as const
export const BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY =
  'browser.clientHost.pageMetadata.v1' as const
export const BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY =
  'browser.clientHost.automation.v1' as const
// Why: without it a client-placed browser.upload would resolve remote paths on the desktop filesystem, so uploads fail closed instead.
export const BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY =
  'browser.clientHost.fileChannel.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const
// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: paired clients may unmount xterm only when the host can return a
// bounded, sequenced scrollback snapshot for lossless reveal.
export const TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY = 'terminal.paired-parking.v1' as const
// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const
export const AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY =
  'agent-session.omp-resume-path.v1' as const
// Why: adding kimi to RESUMABLE_TUI_AGENTS grows terminal.ensureAgentSession's enum, and an
// older host answers the unknown member with invalid_argument — a code the launch fallback does
// not retry on — so clients must probe before taking the host-authority path.
export const AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY = 'agent-session.kimi-resume.v1' as const
// Why: older runtimes strip mutation owner fields, so clients must fence writes before RPC.
export const FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY = 'files.mutation-ownership.v1' as const
export const FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE =
  'Remote file changes require a newer Orca server. Update the HUB and try again.'
export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const
export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const

// Generic native clients include the CLI and must not claim Electron-only page
// placement support.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
] as const

// Electron clients can decode client-hosted page placement; becoming a page
// host still requires the separate authenticated browser-client lease.
export const ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  ...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
] as const

export const RUNTIME_CAPABILITIES = [
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  'terminal.binary-stream.v1',
  'terminal.multiplex.v1',
  'workspace-ports.v1',
  'mobile.tasks.v1',
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  REMOTE_SERVER_UPDATE_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_DELETE_CAPABILITY
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
