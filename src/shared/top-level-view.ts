import type { TopLevelView } from './types'

// Record keys are exhaustive so adding a top-level view also updates every
// persistence boundary that validates values loaded from disk or IPC.
const TOP_LEVEL_VIEW_LOOKUP: Record<TopLevelView, true> = {
  terminal: true,
  settings: true,
  tasks: true,
  activity: true,
  automations: true,
  space: true,
  skills: true,
  mobile: true
}

export function isTopLevelView(value: unknown): value is TopLevelView {
  return typeof value === 'string' && value in TOP_LEVEL_VIEW_LOOKUP
}
