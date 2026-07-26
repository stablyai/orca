import {
  hasUnsafeProviderSessionIdChars,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import type { RuntimeTerminalCreate, RuntimeTerminalPresentation } from './runtime-types'
import { isTerminalLeafId } from './stable-pane-id'
import { isValidTerminalTabId } from './terminal-tab-id'
import type { TuiAgent } from './types'

export { AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY as AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from './protocol-version'

export const AGENT_SESSION_RPC_ERROR_CODES = [
  'agent_session_identity_required',
  'agent_session_conflict',
  'agent_session_resume_not_authorized',
  'agent_session_exited_during_start',
  'agent_session_claim_unavailable',
  'agent_session_ownership_unknown',
  'agent_session_checkpoint_stale',
  'agent_session_operation_invalid',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity',
  'agent_session_legacy_required',
  'execution_owner_reconciling',
  'execution_owner_unavailable'
] as const

export type AgentSessionRpcErrorCode = (typeof AGENT_SESSION_RPC_ERROR_CODES)[number]

export const AGENT_SESSION_CLAIM_DIGEST_VERSION = 1 as const

export const AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION = 2 as const
export const AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION = 1 as const

export const AGENT_SESSION_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000
export const AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS = 24 * 60 * 60 * 1000

const AGENT_SESSION_OPERATION_ID_PATTERN = /^(\d{13})-[0-9a-f]{32}$/

export function parseAgentSessionOperationTimestamp(operationId: string): number | null {
  const match = AGENT_SESSION_OPERATION_ID_PATTERN.exec(operationId)
  if (!match) {
    return null
  }
  const timestamp = Number(match[1])
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const SHA256_BASE64URL_LENGTH = 43

function isBoundedWireString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasUnsafeProviderSessionIdChars(value)
  )
}

export type AgentSessionSurfaceBinding = {
  worktreeId: string
  tabId: string
  leafId: string
  terminalHandle: string
}

export type AgentSessionExecutionClaim = {
  digestVersion: typeof AGENT_SESSION_CLAIM_DIGEST_VERSION
  keyId: string
  identityDigest: string
  worktreeScopeDigest: string
  agent: ResumableTuiAgent
}

export type AgentSessionOwnerBinding = {
  claim: AgentSessionExecutionClaim
  generation: string
  phase: 'reserved' | 'live'
  ptyId: string
  surface: AgentSessionSurfaceBinding
}

export type AgentSessionClaimedSpawnResult = {
  disposition: 'created' | 'adopted'
  owner: AgentSessionOwnerBinding
}

export type AgentLaunchPreferences = {
  model?: string
  effort?: string
  mode?: string
}

export type AgentPromptDelivery = 'auto-submit' | 'draft'

export type RuntimeEnsureAgentSessionRequest =
  | {
      kind: 'automatic'
      sleepingCheckpointId: string
      presentation?: RuntimeTerminalPresentation
    }
  | {
      kind: 'explicit'
      worktree: string
      agent: ResumableTuiAgent
      providerSession: AgentProviderSessionMetadata
      ompResumeFilePath?: string
      /** Explicit client override. Omission keeps launch defaults host-owned. */
      agentArgs?: string | null
      launchPreferences?: AgentLaunchPreferences
      presentation?: RuntimeTerminalPresentation
      placement?: { tabId?: string; leafId?: string }
    }

export type RuntimeEnsureAgentSessionResult = {
  terminal: RuntimeTerminalCreate
  disposition: 'created' | 'adopted'
}

export type RuntimeCreateAgentSessionRequest = {
  clientOperationId: string
  worktree: string
  agent: TuiAgent
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  /** Explicit client override. Omission keeps launch defaults host-owned. */
  agentArgs?: string | null
  launchPreferences?: AgentLaunchPreferences
  startupCwd?: string
  presentation?: RuntimeTerminalPresentation
  placement?: { tabId?: string; leafId?: string }
  viewMode?: 'terminal' | 'chat'
}

export type RuntimeCreateAgentSessionResult = {
  terminal: RuntimeTerminalCreate
  disposition: 'created' | 'replayed'
}

export type RuntimeAgentSessionRpcCaller = {
  clientId?: string
  clientKind?: 'mobile' | 'runtime'
  signal?: AbortSignal
}

export function isAgentSessionExecutionClaim(value: unknown): value is AgentSessionExecutionClaim {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const claim = value as Partial<AgentSessionExecutionClaim>
  return (
    claim.digestVersion === AGENT_SESSION_CLAIM_DIGEST_VERSION &&
    isBoundedWireString(claim.keyId, 128) &&
    BASE64URL_RE.test(claim.keyId) &&
    typeof claim.identityDigest === 'string' &&
    claim.identityDigest.length === SHA256_BASE64URL_LENGTH &&
    BASE64URL_RE.test(claim.identityDigest) &&
    typeof claim.worktreeScopeDigest === 'string' &&
    claim.worktreeScopeDigest.length === SHA256_BASE64URL_LENGTH &&
    BASE64URL_RE.test(claim.worktreeScopeDigest) &&
    isResumableTuiAgent(claim.agent)
  )
}

export function isAgentSessionSurfaceBinding(value: unknown): value is AgentSessionSurfaceBinding {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const surface = value as Partial<AgentSessionSurfaceBinding>
  return (
    isBoundedWireString(surface.worktreeId, 4096) &&
    isBoundedWireString(surface.tabId, 512) &&
    isValidTerminalTabId(surface.tabId) &&
    typeof surface.leafId === 'string' &&
    isTerminalLeafId(surface.leafId) &&
    isBoundedWireString(surface.terminalHandle, 128) &&
    surface.terminalHandle.startsWith('term_') &&
    BASE64URL_RE.test(surface.terminalHandle)
  )
}

export function isAgentSessionOwnerBinding(value: unknown): value is AgentSessionOwnerBinding {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const owner = value as Partial<AgentSessionOwnerBinding>
  return (
    isAgentSessionExecutionClaim(owner.claim) &&
    isBoundedWireString(owner.generation, 128) &&
    (owner.phase === 'reserved' || owner.phase === 'live') &&
    isBoundedWireString(owner.ptyId, 4096) &&
    isAgentSessionSurfaceBinding(owner.surface)
  )
}

export function isAgentSessionClaimedSpawnResult(
  value: unknown
): value is AgentSessionClaimedSpawnResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const result = value as Partial<AgentSessionClaimedSpawnResult>
  return (
    (result.disposition === 'created' || result.disposition === 'adopted') &&
    isAgentSessionOwnerBinding(result.owner) &&
    result.owner.phase === 'live'
  )
}
