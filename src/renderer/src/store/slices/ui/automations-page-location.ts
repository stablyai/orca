import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorktreeNavHistoryEntry } from './workspace-navigation-history'

/** Where a run page was opened from; Escape returns there. */
export type AutomationRunPageOrigin = 'runs' | 'automation' | 'automationRuns'

/** One Automations sub-page, as recorded in app back/forward history. */
export type AutomationsPageLocation =
  | { page: 'list' }
  | { page: 'runs' }
  | { page: 'detail'; automationId: string; hostId?: ExecutionHostId }
  | { page: 'automationRuns'; automationId: string; hostId?: ExecutionHostId }
  | {
      page: 'run'
      automationId: string
      runId: string
      hostId?: ExecutionHostId
      origin: AutomationRunPageOrigin
    }
  | { page: 'external'; externalKey: string }

/** How the next recorded sub-page enters history: a new step, or a step back to its parent. */
export type AutomationsPageVisitMode = 'push' | 'return'

/** Identity for de-duplication; the run origin is how the user got there, not where they are. */
export function automationsPageLocationKey(location: AutomationsPageLocation): string {
  switch (location.page) {
    case 'list':
    case 'runs':
      return location.page
    case 'detail':
    case 'automationRuns':
      return `${location.page}:${location.hostId ?? ''}:${location.automationId}`
    case 'run':
      return `run:${location.hostId ?? ''}:${location.automationId}:${location.runId}`
    case 'external':
      return `external:${location.externalKey}`
  }
}

/** The plain page sentinel or one of its sub-pages. */
export function isAutomationsHistoryEntry(entry: WorktreeNavHistoryEntry | undefined): boolean {
  return entry === 'automations' || (typeof entry === 'object' && entry.kind === 'automations-page')
}
