// Build SSH hook envelopes from parsed events/raw bodies; publication owns shedding and redelivery.
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookRelayEnvelope, AgentHookSource } from '../shared/agent-hook-relay'
import { hasSeparateHookSessionAdmission } from '../shared/agent-hook-listener/pane-provider-session'
import { pickHostTurnEnd } from '../shared/agent-status-types'

// Why: cap metadata to prevent a misbehaving CLI growing the cache unboundedly.
const MAX_HOOK_META_LEN = 64
// Rows main's producer sent as PermissionRequest or as held working; lifecycle rows keep their meaning.
const PERMISSION_SNAPSHOT_CAUSES = new Set([
  undefined,
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch'
])

/** Older receivers hold a wait only behind a PermissionRequest row, so they see the pending request's own identity. */
function claudeHookIdentity(event: AgentHookEventPayload) {
  const hook = {
    hookEventName: event.hookEventName,
    toolUseId: event.toolUseId,
    toolAgentId: event.toolAgentId,
    toolAgentType: event.toolAgentType
  }
  const permission = event.claudePermissionState
  if (
    !permission?.pending ||
    event.payload.state !== 'waiting' ||
    !PERMISSION_SNAPSHOT_CAUSES.has(event.hookEventName)
  ) {
    return { ...hook, claudePermissionState: permission }
  }
  return {
    hookEventName: 'PermissionRequest',
    toolUseId: permission.pending.toolUseId,
    toolAgentId: permission.pending.toolAgentId,
    toolAgentType: permission.pending.toolAgentType,
    claudePermissionState: { ...permission, cause: hook }
  }
}

export function buildRelayHookEnvelope(
  event: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options: { isReplay?: boolean } = {}
): AgentHookRelayEnvelope {
  return {
    source,
    ...(event.hostEvidenceObservedAt !== undefined
      ? { evidenceAgeMs: Math.max(0, Date.now() - event.hostEvidenceObservedAt) }
      : {}),
    agentPresence: hasSeparateHookSessionAdmission(source)
      ? {
          agent: source,
          session: event.statusAdmissionSession
        }
      : event.agentPresence,
    paneKey: event.paneKey,
    ...(event.hostTurnRevision ? { hostTurnRevision: event.hostTurnRevision } : {}),
    ...(event.launchToken ? { launchToken: event.launchToken } : {}),
    tabId: event.tabId,
    worktreeId: event.worktreeId,
    connectionId: null,
    hasExplicitPrompt: event.hasExplicitPrompt,
    promptInteractionKey: event.promptInteractionKey,
    providerPromptId: event.providerPromptId,
    grokPromptBoundary: event.grokPromptBoundary,
    compactTrigger: event.compactTrigger,
    ...claudeHookIdentity(event),
    claudeSettledRequests: event.claudeSettledRequests,
    teammateName: event.teammateName,
    claudeRunningNonAgentTask: event.claudeRunningNonAgentTask,
    ...(event.providerSession ? { providerSession: event.providerSession } : {}),
    ...(event.providerSessionOnly ? { providerSessionOnly: true } : {}),
    isReplay: options.isReplay === true ? true : undefined,
    ...pickHostTurnEnd(event),
    env,
    version,
    payload: event.payload
  }
}

export function hookBodyEnv(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const v = (body as Record<string, unknown>).env
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
    return undefined
  }
  return v
}

export function hookBodyVersion(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const v = (body as Record<string, unknown>).version
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
    return undefined
  }
  return v
}
