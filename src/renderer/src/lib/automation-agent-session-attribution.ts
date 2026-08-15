import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentStatusState } from '../../../shared/agent-status-types'
import type { AutomationRunCompletionAttribution } from '../../../shared/automation-run-completion-attribution'
import type { AutomationRunUsageProvider } from '../../../shared/automations-types'

/** Identity fields needed to attribute automation completion to a session. */
export type AutomationAgentSessionIdentity = {
  state: AgentStatusState
  providerSession?: AgentProviderSessionMetadata | null
}

export type AutomationAgentSessionTracker = {
  /** Provider session bound as the automation's primary agent after first live status. */
  boundFingerprint: string | null
  /** Fingerprint that actually authorized completion; exit/fallback must not reuse bind. */
  authorizedFingerprint: string | null
  sawWorkingAfterStart: boolean
}

export function createAutomationAgentSessionTracker(): AutomationAgentSessionTracker {
  return {
    boundFingerprint: null,
    authorizedFingerprint: null,
    sawWorkingAfterStart: false
  }
}

/** Stable key for a provider session; null when hooks did not report one. */
export function resolveAutomationAgentSessionFingerprint(
  identity: Pick<AutomationAgentSessionIdentity, 'providerSession'>
): string | null {
  const session = identity.providerSession
  const id = typeof session?.id === 'string' ? session.id.trim() : ''
  if (!id) {
    return null
  }
  const key = session?.key === 'conversation_id' ? 'conversation_id' : 'session_id'
  return `${key}:${id}`
}

/**
 * Observe one agent-status sample for the automation pane.
 * Returns true only when this sample should finalize the run.
 *
 * Why: nested `claude -p` (SessionStart plugins) shares the parent paneKey but has a
 * different provider session id. Bind the first *working* session after dispatch and
 * require done to match so nested short sessions cannot finalize/kill the primary (#10999).
 *
 * Full launcher-identity bind (session id from launchAgentBackgroundSession) is deferred;
 * until then, never bind from done and ignore fingerprint-bearing done before any working.
 */
export function noteAutomationAgentStatus(
  tracker: AutomationAgentSessionTracker,
  identity: AutomationAgentSessionIdentity,
  options?: { requireWorkingAfterStart?: boolean }
): boolean {
  const fingerprint = resolveAutomationAgentSessionFingerprint(identity)
  const isLive =
    identity.state === 'working' || identity.state === 'blocked' || identity.state === 'waiting'

  if (isLive) {
    if (fingerprint) {
      // Bind only from working so blocked/waiting noise cannot steal primary identity.
      if (identity.state === 'working' && tracker.boundFingerprint === null) {
        tracker.boundFingerprint = fingerprint
      }
      if (identity.state === 'working' && tracker.boundFingerprint === fingerprint) {
        tracker.sawWorkingAfterStart = true
      }
    } else if (identity.state === 'working' && tracker.boundFingerprint === null) {
      tracker.sawWorkingAfterStart = true
    }
    return false
  }

  if (identity.state !== 'done') {
    return false
  }

  // Nested short sessions often emit only done with a foreign session id. Never bind
  // from done, and do not finalize until a working sample has established primary.
  if (fingerprint && tracker.boundFingerprint === null) {
    return false
  }

  if (tracker.boundFingerprint) {
    // Nested / foreign session completion on the same pane is not the run finishing.
    if (!fingerprint || fingerprint !== tracker.boundFingerprint) {
      return false
    }
  }

  if (options?.requireWorkingAfterStart && !tracker.sawWorkingAfterStart) {
    return false
  }

  tracker.authorizedFingerprint = tracker.boundFingerprint
  return true
}

export function resolveAutomationRunUsageProvider(
  agentId: string
): AutomationRunUsageProvider | null {
  return agentId === 'claude' || agentId === 'codex' ? agentId : null
}

function parseBoundFingerprint(fingerprint: string | null): {
  key: 'session_id' | 'conversation_id'
  id: string
} | null {
  if (!fingerprint) {
    return null
  }
  const separator = fingerprint.indexOf(':')
  if (separator <= 0 || separator === fingerprint.length - 1) {
    return null
  }
  const key = fingerprint.slice(0, separator)
  const id = fingerprint.slice(separator + 1)
  if (key !== 'session_id' && key !== 'conversation_id') {
    return null
  }
  return { key, id }
}

/** Persistable receipt: exact only when a matching done authorized the bound session. */
export function buildAutomationRunCompletionAttribution(args: {
  tracker: AutomationAgentSessionTracker
  provider: AutomationRunUsageProvider | null
  terminalPtyId: string | null
  terminalPaneKey: string | null
}): AutomationRunCompletionAttribution {
  const parsed = parseBoundFingerprint(args.tracker.authorizedFingerprint)
  if (!parsed) {
    return {
      kind: 'pane_time_fallback',
      provider: args.provider,
      providerSessionKey: null,
      providerSessionId: null,
      terminalPtyId: args.terminalPtyId,
      terminalPaneKey: args.terminalPaneKey
    }
  }
  return {
    kind: 'exact_provider_session',
    provider: args.provider,
    providerSessionKey: parsed.key,
    providerSessionId: parsed.id,
    terminalPtyId: args.terminalPtyId,
    terminalPaneKey: args.terminalPaneKey
  }
}
