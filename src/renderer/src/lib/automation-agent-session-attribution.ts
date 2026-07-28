import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentStatusState } from '../../../shared/agent-status-types'

/** Identity fields needed to attribute automation completion to a session. */
export type AutomationAgentSessionIdentity = {
  state: AgentStatusState
  providerSession?: AgentProviderSessionMetadata | null
}

export type AutomationAgentSessionTracker = {
  /** Provider session bound as the automation's primary agent after first live status. */
  boundFingerprint: string | null
  sawWorkingAfterStart: boolean
}

export function createAutomationAgentSessionTracker(): AutomationAgentSessionTracker {
  return {
    boundFingerprint: null,
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
 * different provider session id. Binding the first live session after dispatch and
 * requiring done to match prevents early finalization / kill of the real agent (#10999).
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
      // First live session after dispatch is the primary agent; later nested
      // sessions on the same pane must not rebind.
      if (tracker.boundFingerprint === null) {
        tracker.boundFingerprint = fingerprint
      }
      if (tracker.boundFingerprint === fingerprint) {
        tracker.sawWorkingAfterStart = true
      }
    } else if (tracker.boundFingerprint === null) {
      tracker.sawWorkingAfterStart = true
    }
    return false
  }

  if (identity.state !== 'done') {
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

  return true
}
