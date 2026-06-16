// Pure filter predicates shared by the renderer and the CLI so both agree on
// what "enabled", "in folder X", "matches search", and "failed last run" mean.
// Keep this dependency-free: it must import only types.
import type { Automation, AutomationRunStatus } from './automations-types'

export type AutomationStatusFilter = 'all' | 'enabled' | 'paused'

export type AutomationLastRunFilter = 'any' | 'completed' | 'failed' | 'skipped'

/** null = the "Unfiled" bucket; undefined/absent on the filter means no folder
 *  constraint (show every folder). */
export type AutomationFolderFilter = string | null

/** Lookup of automationId -> the status of that automation's most recent run.
 *  A missing key means the automation has never run. */
export type AutomationLastRunStatusLookup = Readonly<Record<string, AutomationRunStatus>>

export type AutomationFilterCriteria = {
  status?: AutomationStatusFilter
  folderId?: AutomationFolderFilter
  search?: string
  lastRun?: AutomationLastRunFilter
}

export function matchesAutomationStatus(
  automation: Automation,
  status: AutomationStatusFilter
): boolean {
  if (status === 'all') {
    return true
  }
  return status === 'enabled' ? automation.enabled : !automation.enabled
}

export function matchesAutomationFolder(
  automation: Automation,
  folderId: AutomationFolderFilter
): boolean {
  // null matches the unfiled bucket (folderId null or legacy-absent).
  return (automation.folderId ?? null) === folderId
}

export function matchesAutomationSearch(automation: Automation, search: string): boolean {
  const normalized = search.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  return (
    automation.name.toLowerCase().includes(normalized) ||
    automation.prompt.toLowerCase().includes(normalized)
  )
}

/** Map a raw run status to the coarse last-run bucket used by the filter chip.
 *  Returns null when the status is in-flight (pending/dispatching/dispatched),
 *  which no last-run bucket should match. */
export function classifyAutomationLastRun(
  status: AutomationRunStatus
): Exclude<AutomationLastRunFilter, 'any'> | null {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'dispatch_failed':
      return 'failed'
    case 'skipped_precheck':
    case 'skipped_missed':
    case 'skipped_unavailable':
    case 'skipped_needs_interactive_auth':
      return 'skipped'
    case 'pending':
    case 'dispatching':
    case 'dispatched':
      // In-flight: no terminal last-run bucket applies.
      return null
  }
}

export function matchesAutomationLastRun(
  automation: Automation,
  lastRun: AutomationLastRunFilter,
  lastRunStatusByAutomationId: AutomationLastRunStatusLookup
): boolean {
  if (lastRun === 'any') {
    return true
  }
  const status = lastRunStatusByAutomationId[automation.id]
  if (status === undefined) {
    return false
  }
  return classifyAutomationLastRun(status) === lastRun
}

/** AND-compose every active criterion over the automations list. Omitted
 *  criteria (and the sentinel defaults 'all'/'any'/empty search) are no-ops, so
 *  callers can pass only the axes the user has touched. */
export function filterAutomations(
  automations: readonly Automation[],
  criteria: AutomationFilterCriteria,
  lastRunStatusByAutomationId: AutomationLastRunStatusLookup = {}
): Automation[] {
  return automations.filter((automation) => {
    if (criteria.status !== undefined && !matchesAutomationStatus(automation, criteria.status)) {
      return false
    }
    if (
      criteria.folderId !== undefined &&
      !matchesAutomationFolder(automation, criteria.folderId)
    ) {
      return false
    }
    if (criteria.search !== undefined && !matchesAutomationSearch(automation, criteria.search)) {
      return false
    }
    if (
      criteria.lastRun !== undefined &&
      !matchesAutomationLastRun(automation, criteria.lastRun, lastRunStatusByAutomationId)
    ) {
      return false
    }
    return true
  })
}
