import { INTERRUPTED_TURN_CONTINUE_PROMPT } from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Interrupted turns already continued, so a retried cold restore never sends `continue` twice. */
const continuedInterruptedTurns = new Set<string>()

type InterruptedTurnEntry = {
  state: string
  updatedAt: number
  stateStartedAt?: number
}

/** Identity of the turn an agent was in when its host went away. */
export function interruptedTurnKey(
  entry: { updatedAt: number; stateStartedAt?: number },
  paneKey: string
): string {
  return `${paneKey}\u0000${entry.stateStartedAt ?? entry.updatedAt}`
}

/** True once some path (a cold-restore resume or a restart nudge) sent this turn's `continue`. */
export function isInterruptedTurnContinued(key: string): boolean {
  return continuedInterruptedTurns.has(key)
}

/** Called when a resume that carries `continue` actually launches (startups are often built and
 *  discarded, e.g. on every reattach check). */
export function markInterruptedTurnContinued(key: string | undefined): void {
  if (key) {
    continuedInterruptedTurns.add(key)
  }
}

/**
 * A cold-restored agent on a remote host whose last status was working lost its turn when the host
 * restarted (reboot, crash, rollover): carry it on. Only with fresh evidence (a recent working
 * status), never after a deliberate sleep (that leaves a sleeping record), once per interrupted turn.
 * Local panes are left alone: their PTYs outlive app restarts.
 */
export function shouldContinueInterruptedTurn(
  entry: InterruptedTurnEntry | null | undefined,
  runtimeEnvironmentId: string | null,
  context: { paneKey: string; hasSleepingRecord: boolean; now?: number }
): boolean {
  if (!runtimeEnvironmentId || context.hasSleepingRecord || entry?.state !== 'working') {
    return false
  }
  if ((context.now ?? Date.now()) - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return false
  }
  return !continuedInterruptedTurns.has(interruptedTurnKey(entry, context.paneKey))
}

/**
 * A remote host that restarted under a working agent (reboot, crash, VM rollover) killed it
 * mid-turn; its last status still says working. Carry the turn on instead of waiting.
 */
export function resolveColdRestoreInterruptedTurn(
  session: ConnectPanePtySession,
  entry: InterruptedTurnEntry | null,
  hasSleepingRecord: boolean
): {
  continuePrompt: string | null
  startupFields: { interruptedTurnKey?: string }
} {
  const continueTurn =
    entry !== null &&
    shouldContinueInterruptedTurn(entry, session.transport.getRuntimeEnvironmentId?.() ?? null, {
      paneKey: session.cacheKey,
      hasSleepingRecord
    })
  return continueTurn && entry
    ? {
        continuePrompt: INTERRUPTED_TURN_CONTINUE_PROMPT,
        startupFields: {
          interruptedTurnKey: interruptedTurnKey(entry, session.cacheKey)
        }
      }
    : { continuePrompt: null, startupFields: {} }
}
