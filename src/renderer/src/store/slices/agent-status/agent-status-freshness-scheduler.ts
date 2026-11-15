import { agentEntryCompletionAt } from '../../../../../shared/agent-status/lifecycle/agent-completion-time'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt
} from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'
import type { AcceptedAgentStatuses } from './accepted-agent-statuses'
import type { AgentStatusChange } from './agent-status-contract'

export type FreshnessSchedulerDeps = {
  getStatusEntries: () => AcceptedAgentStatuses
  bumpEpochs: (keys?: readonly string[]) => void
}
export type FreshnessScheduler = {
  schedule: () => void
  scheduleDeferred: () => void
  noteChanges: (changes: readonly AgentStatusChange[]) => void
  dispose: () => void
}
export const agentStatusFreshnessScanCounters = { fullScans: 0, cachedScans: 0, entryVisits: 0 }
export function resetAgentStatusFreshnessScanCounters(): void {
  agentStatusFreshnessScanCounters.fullScans = 0
  agentStatusFreshnessScanCounters.cachedScans = 0
  agentStatusFreshnessScanCounters.entryVisits = 0
}

export function createFreshnessScheduler(deps: FreshnessSchedulerDeps): FreshnessScheduler {
  const deadlines = new KeyedDeadlines()
  let source: AcceptedAgentStatuses | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = null
  }
  const update = (key: string, entry: AgentStatusEntry | undefined, now: number): void => {
    agentStatusFreshnessScanCounters.entryVisits++
    const hook = entry
      ? agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS
      : -Infinity
    const completed = entry ? agentEntryCompletionAt(entry) : null
    const completion = completed === null ? -Infinity : completed + AGENT_STATUS_STALE_AFTER_MS
    deadlines.set(`hook\0${key}`, hook >= now ? hook : undefined)
    deadlines.set(`completion\0${key}`, completion >= now ? completion : undefined)
  }
  const reconcile = (): void => {
    const next = deps.getStatusEntries()
    if (source?.sharesOwner(next)) {
      return
    }
    deadlines.clear()
    agentStatusFreshnessScanCounters.fullScans++
    const now = Date.now()
    for (const [key, entry] of next) {
      update(key, entry, now)
    }
    source = next
  }
  const schedule = (): void => {
    clear()
    const now = Date.now()
    const due = deadlines.takeDue(now)
    reconcile()
    if (due.length) {
      deps.bumpEpochs([...new Set(due.map((key) => key.slice(key.indexOf('\0') + 1)))])
    }
    agentStatusFreshnessScanCounters.cachedScans++
    if (Number.isFinite(deadlines.next)) {
      timer = setTimeout(schedule, Math.max(0, deadlines.next - now + 1))
    }
  }
  const scheduleDeferred = (): void => {
    const requested = ++generation
    queueMicrotask(() => {
      if (requested === generation) {
        schedule()
      }
    })
  }
  const noteChanges = (changes: readonly AgentStatusChange[]): void => {
    // Drain old deadlines before an incoming heartbeat can replace a crossed completion clock.
    const now = Date.now()
    const due = deadlines.takeDue(now)
    reconcile()
    if (due.length) {
      deps.bumpEpochs([...new Set(due.map((key) => key.slice(key.indexOf('\0') + 1)))])
    }
    for (const change of changes) {
      update(change.paneKey, change.current, now)
    }
    scheduleDeferred()
  }
  return {
    schedule,
    scheduleDeferred,
    noteChanges,
    dispose: () => {
      clear()
      deadlines.clear()
      source = null
      generation++
    }
  }
}
