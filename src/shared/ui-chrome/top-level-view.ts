import type { TopLevelView } from './ui-chrome-types'

// Exhaustive keys make new views update every persistence/IPC validator.
const TOP_LEVEL_VIEW_LOOKUP: Record<TopLevelView, true> = {
  terminal: true,
  settings: true,
  tasks: true,
  activity: true,
  automations: true,
  space: true,
  skills: true,
  artifacts: true,
  mobile: true,
  shareRequest: true
}

// Views shown for something of this run only, so never saved or sent to a host (an older one would
// refuse the value): a share request's page. Launch opens the workspace instead.
const UNSAVED_TOP_LEVEL_VIEWS: ReadonlySet<TopLevelView> = new Set(['shareRequest'])

/** A view the saved active view may hold: known, and not one of this run only. */
export function isSavedTopLevelView(value: unknown): value is TopLevelView {
  return isTopLevelView(value) && !UNSAVED_TOP_LEVEL_VIEWS.has(value)
}

export function isTopLevelView(value: unknown): value is TopLevelView {
  // Reject inherited prototype keys from corrupt sidecars or they can blank the main surface.
  return typeof value === 'string' && Object.hasOwn(TOP_LEVEL_VIEW_LOOKUP, value)
}
