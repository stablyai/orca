import { ACCOUNT_RUNTIME_CAPABILITIES } from './account-runtime-capabilities'
import * as agentLaunchCapabilities from './agent-launch-runtime-capability'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_RUNTIME_CAPABILITIES
} from './agent-session-runtime-capabilities'
import { AI_VAULT_RUNTIME_CAPABILITIES } from './ai-vault-runtime-capabilities'
import {
  AUTOMATION_RUNTIME_CAPABILITIES,
  AUTOMATION_RUNTIME_CLIENT_CAPABILITIES
} from './automation-runtime-capabilities'
import { BROWSER_RUNTIME_CAPABILITIES } from './browser-runtime-capabilities'
import { DEVICE_KEY_RUNTIME_CAPABILITIES } from './device-key-capability'
import { FILES_RUNTIME_CAPABILITIES } from './files-runtime-capabilities'
import { HOST_RUNTIME_CAPABILITIES } from './host-runtime-capabilities'
import { MOBILE_RUNTIME_CAPABILITIES } from './mobile-runtime-capabilities'
import { ORCAD_RUNTIME_CAPABILITIES } from './orcad-runtime-capabilities'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from './orchestration-runtime-capabilities'
import { PREFLIGHT_RUNTIME_CAPABILITIES } from './preflight-runtime-capabilities'
import {
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_RUNTIME_CAPABILITIES
} from './session-tabs-runtime-capabilities'
import { SKILL_RUNTIME_CAPABILITIES } from './skill-install-capability'
import { SOURCE_CONTROL_RUNTIME_CAPABILITIES } from './source-control-runtime-capabilities'
import { TASK_SOURCE_RUNTIME_CAPABILITIES } from './task-source-runtime-capabilities'
import { TERMINAL_RUNTIME_CAPABILITIES } from './terminal-runtime-capabilities'
import { WORKSPACE_PORTS_RUNTIME_CAPABILITIES } from './workspace-ports-runtime-capabilities'
import {
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_RUNTIME_CAPABILITIES,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from './worktree-runtime-capabilities'

// Runtime protocol ranges permit app-version drift across desktop/server/CLI/mobile. Bump for removed methods/required params,
// changed field meaning (units/nullability), framing or auth; optional fields, new methods and ignorable events are additive.
// Raise minimum client/server versions to refuse unsupported peers; never require equal app versions.

export const RUNTIME_PROTOCOL_VERSION = 3
export const MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2

// Why stars: importers keep reading every capability from here while each area owns its module.
export * from './agent-session-runtime-capabilities'
export * from './agent-session-resume-runtime-capabilities'
export * from './agent-session-stop-capabilities'
export * from './ai-vault-runtime-capabilities'
export * from './browser-runtime-capabilities'
export * from './files-runtime-capabilities'
export * from './host-runtime-capabilities'

export * from './mobile-runtime-capabilities'
export * from './preflight-runtime-capabilities'
export * from './source-control-runtime-capabilities'
export * from './task-source-runtime-capabilities'
export * from './terminal-runtime-capabilities'
export * from './workspace-ports-runtime-capabilities'
export * from './worktree-runtime-capabilities'
export { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
export { TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY } from './terminal-quick-command-capabilities'
export {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY
} from './automation-runtime-capabilities'
export {
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY
} from './structured-agent-session-surface-capabilities'
export {
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
} from './agent-session-attention-capabilities'
export {
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
} from './orchestration-runtime-capabilities'
export {
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY
} from './session-tabs-runtime-capabilities'

// Native clients include the CLI, which cannot place Electron browser pages.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  ...AUTOMATION_RUNTIME_CLIENT_CAPABILITIES,
  agentLaunchCapabilities.AGENT_LAUNCH_RUNTIME_CAPABILITY
] as const

// Each area lists what it publishes in its own module; a new capability edits only that module.
export const SAVED_RESUME_ORIGIN_RUNTIME_CAPABILITY =
  'agent-session.saved-resume-origin.v1' as const

export const RUNTIME_CAPABILITIES = [
  SAVED_RESUME_ORIGIN_RUNTIME_CAPABILITY,
  ...HOST_RUNTIME_CAPABILITIES,
  ...DEVICE_KEY_RUNTIME_CAPABILITIES,
  ...MOBILE_RUNTIME_CAPABILITIES,
  ...ORCAD_RUNTIME_CAPABILITIES,
  ...ORCHESTRATION_RUNTIME_CAPABILITIES,
  ...agentLaunchCapabilities.AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_RUNTIME_CAPABILITIES,
  ...ACCOUNT_RUNTIME_CAPABILITIES,
  ...SKILL_RUNTIME_CAPABILITIES,
  ...AUTOMATION_RUNTIME_CAPABILITIES,
  ...WORKTREE_RUNTIME_CAPABILITIES,
  ...PREFLIGHT_RUNTIME_CAPABILITIES,
  ...WORKSPACE_PORTS_RUNTIME_CAPABILITIES,
  ...SESSION_TABS_RUNTIME_CAPABILITIES,
  ...TERMINAL_RUNTIME_CAPABILITIES,
  ...FILES_RUNTIME_CAPABILITIES,
  ...BROWSER_RUNTIME_CAPABILITIES,
  ...SOURCE_CONTROL_RUNTIME_CAPABILITIES,
  ...TASK_SOURCE_RUNTIME_CAPABILITIES,
  ...AI_VAULT_RUNTIME_CAPABILITIES
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
