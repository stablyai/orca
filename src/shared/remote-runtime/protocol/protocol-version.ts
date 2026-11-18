import {
  PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY,
  PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
} from '../../project/groups/project-group-order-capability'
import { EMULATOR_RUNTIME_CAPABILITIES } from './emulator-runtime-capabilities'
import { ACCOUNT_RUNTIME_CAPABILITIES } from './account-runtime-capabilities'
import * as agentLaunchCapabilities from '../../agent-launch/contracts/agent-launch-runtime-capability'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_RUNTIME_CAPABILITIES
} from '../../agent-session/capabilities/agent-session-runtime-capabilities'
import { AI_VAULT_RUNTIME_CAPABILITIES } from '../../ai-vault/contracts/ai-vault-runtime-capabilities'
import {
  AUTOMATION_RUNTIME_CAPABILITIES,
  AUTOMATION_RUNTIME_CLIENT_CAPABILITIES
} from '../../automations/automation-runtime-capabilities'
import { BOT_RUNTIME_CAPABILITIES } from '../../bot-runtime-capabilities'
import { BROWSER_RUNTIME_CAPABILITIES } from '../../browser/runtime/browser-runtime-capabilities'
import {
  DEVICE_KEY_RUNTIME_CAPABILITIES,
  E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY
} from '../pairing/device-key-capability'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITIES } from '../pairing/ticket-exchange-capability'
import { PAIRING_OFFER_CREATOR_RUNTIME_CAPABILITY } from '../pairing/pairing-offer-creator-capability'
import { FILES_RUNTIME_CAPABILITIES } from '../../file-access/files-runtime-capabilities'
import { HOST_RUNTIME_CAPABILITIES } from './host-runtime-capabilities'
import { MOBILE_RUNTIME_CAPABILITIES } from './mobile-runtime-capabilities'
import { ORCAD_RUNTIME_CAPABILITIES } from './orcad-runtime-capabilities'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from '../../orchestration/orchestration-runtime-capabilities'
import { PERFORCE_RUNTIME_CAPABILITIES } from '../../perforce/perforce-runtime-capability'
import { PREFLIGHT_RUNTIME_CAPABILITIES } from './preflight-runtime-capabilities'
import {
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_RUNTIME_CAPABILITIES
} from './session-tabs-runtime-capabilities'
import { SKILL_RUNTIME_CAPABILITIES } from '../../skills/capabilities/skill-install-capability'
import { SOURCE_CONTROL_RUNTIME_CAPABILITIES } from '../../source-control/runtime/source-control-runtime-capabilities'
import { TASK_SOURCE_RUNTIME_CAPABILITIES } from '../../work-items/task-source-runtime-capabilities'
import { TERMINAL_RUNTIME_CAPABILITIES } from '../../terminal/runtime-policy/terminal-runtime-capabilities'
import { WORKSPACE_PORTS_RUNTIME_CAPABILITIES } from './workspace-ports-runtime-capabilities'
import {
  REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY,
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

// Native clients include the CLI, which cannot place Electron browser pages.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY,
  ...AUTOMATION_RUNTIME_CLIENT_CAPABILITIES,
  agentLaunchCapabilities.AGENT_LAUNCH_RUNTIME_CAPABILITY
] as const

// Each area lists what it publishes in its own module; a new capability edits only that module.
export const SAVED_RESUME_ORIGIN_RUNTIME_CAPABILITY =
  'agent-session.saved-resume-origin.v1' as const

// Individual protocol exports must not retain the unused host capability aggregate.
export const RUNTIME_CAPABILITIES = /* @__PURE__ */ (() =>
  [
    ...EMULATOR_RUNTIME_CAPABILITIES,
    SAVED_RESUME_ORIGIN_RUNTIME_CAPABILITY,
    ...HOST_RUNTIME_CAPABILITIES,
    ...DEVICE_KEY_RUNTIME_CAPABILITIES,
    E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY,
    ...PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITIES,
    PAIRING_OFFER_CREATOR_RUNTIME_CAPABILITY,
    ...MOBILE_RUNTIME_CAPABILITIES,
    ...ORCAD_RUNTIME_CAPABILITIES,
    ...ORCHESTRATION_RUNTIME_CAPABILITIES,
    ...agentLaunchCapabilities.AGENT_LAUNCH_RUNTIME_CAPABILITIES,
    ...AGENT_SESSION_RUNTIME_CAPABILITIES,
    ...ACCOUNT_RUNTIME_CAPABILITIES,
    ...SKILL_RUNTIME_CAPABILITIES,
    ...AUTOMATION_RUNTIME_CAPABILITIES,
    ...WORKTREE_RUNTIME_CAPABILITIES,
    PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY,
    PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY,
    ...PREFLIGHT_RUNTIME_CAPABILITIES,
    ...WORKSPACE_PORTS_RUNTIME_CAPABILITIES,
    ...SESSION_TABS_RUNTIME_CAPABILITIES,
    ...TERMINAL_RUNTIME_CAPABILITIES,
    ...FILES_RUNTIME_CAPABILITIES,
    ...BROWSER_RUNTIME_CAPABILITIES,
    ...SOURCE_CONTROL_RUNTIME_CAPABILITIES,
    ...TASK_SOURCE_RUNTIME_CAPABILITIES,
    ...AI_VAULT_RUNTIME_CAPABILITIES,
    ...BOT_RUNTIME_CAPABILITIES,
    ...PERFORCE_RUNTIME_CAPABILITIES
  ] as const)()

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
