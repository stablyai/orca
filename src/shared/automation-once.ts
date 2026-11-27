// A wait: an automation that runs at most once, on its first event or at its deadline, then is deleted.
import {
  isFinalAutomationRunStatus,
  type AutomationRun
} from './automations/history/automation-run'
import type { Automation } from './automations/automation-definition'

/** Absent `by`: it runs only if an event comes, and ends unrun WAIT_EXPIRY_MS after it was made. */
export type AutomationOnce = { by?: number }

export const WAIT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
/** The furthest a wait's deadline may be from when it was made. */
export const WAIT_MAX_DEADLINE_MS = WAIT_EXPIRY_MS * 12

/** When the tick takes it: its deadline, or its expiry without one. */
export function onceDueAt(automation: Pick<Automation, 'once' | 'createdAt'>): number | null {
  if (!automation.once) {
    return null
  }
  return automation.once.by ?? automation.createdAt + WAIT_EXPIRY_MS
}

/** A refused or missed occurrence never starts the agent, so it doesn't spend the one run. */
function claimsTheRun(run: Pick<AutomationRun, 'status'>): boolean {
  return !run.status.startsWith('skipped_')
}

/** Its one run has started; nothing else may start another. */
export function onceClaimed(runs: readonly Pick<AutomationRun, 'status' | 'trigger'>[]): boolean {
  return runs.some((run) => run.trigger !== 'manual' && claimsTheRun(run))
}

/** Its one run started and has since finished, however it ended. */
export function onceRunFinished(
  runs: readonly Pick<AutomationRun, 'status' | 'trigger'>[]
): boolean {
  const claimed = runs.filter((run) => run.trigger !== 'manual' && claimsTheRun(run))
  return claimed.length > 0 && claimed.every((run) => isFinalAutomationRunStatus(run.status))
}

/** How a wait's run ends it: on its event, or at its deadline. Run now ends nothing. Its Wait over
 *  card and the run's message both say this, so a chat can tell one from the other's twin. */
export function onceRunEnding(
  automation: Pick<Automation, 'once'>,
  run: Pick<AutomationRun, 'trigger' | 'scheduledFor' | 'event'>
): WaitEnding | undefined {
  if (!automation.once) {
    return undefined
  }
  if (run.trigger === 'scheduled') {
    return { kind: 'deadline', at: run.scheduledFor }
  }
  return run.trigger === 'event' && run.event
    ? {
        kind: 'event',
        at: run.event.occurredAt,
        ...(run.event.actor ? { actor: run.event.actor } : {})
      }
    : undefined
}

/** Its waits still waiting (their one run not started), deadlines first, soonest first. */
export function pendingWaits<T extends Pick<Automation, 'id' | 'once'>>(
  automations: readonly T[],
  runs: readonly Pick<AutomationRun, 'automationId' | 'status' | 'trigger'>[]
): T[] {
  return automations
    .filter(
      (automation) =>
        automation.once && !onceClaimed(runs.filter((run) => run.automationId === automation.id))
    )
    .sort((a, b) => waitDueAt(a) - waitDueAt(b))
}

/** A wait's deadline; one without sorts last. */
export function waitDueAt(automation: Pick<Automation, 'once'>): number {
  return automation.once?.by ?? Number.MAX_SAFE_INTEGER
}

/** How a wait ended, as its chat card says. */
export type WaitEnding =
  | { kind: 'event'; at: number; actor?: string }
  | { kind: 'deadline'; at: number }
  | { kind: 'expired'; at: number }

/** Its deadline came after it was made, within a year; the CLI also refuses one already past. */
export function assertAutomationOnce(automation: Pick<Automation, 'once' | 'createdAt'>): void {
  const by = automation.once?.by
  if (by === undefined) {
    return
  }
  if (!Number.isFinite(by) || by <= automation.createdAt) {
    throw new Error('A run-once automation needs a --by time after it was made.')
  }
  if (by > automation.createdAt + WAIT_MAX_DEADLINE_MS) {
    throw new Error('--by must be within a year.')
  }
}
