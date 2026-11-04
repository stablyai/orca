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
  mobile: true
}

export function isTopLevelView(value: unknown): value is TopLevelView {
  // Reject inherited prototype keys from corrupt sidecars or they can blank the main surface.
  return typeof value === 'string' && Object.hasOwn(TOP_LEVEL_VIEW_LOOKUP, value)
}
