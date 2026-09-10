// Why its own module: both runtime-odoo-client.ts and its chatter split need
// this resolver, and having either own it makes the two import each other.
import { getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { GlobalSettings } from '../../../shared/global-settings-types'
export type RuntimeOdooSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function isTaskSourceRuntimeSettings(settings: RuntimeOdooSettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getOdooRuntimeTarget(
  settings: RuntimeOdooSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  // Why: task source context makes provider ownership explicit; legacy callers
  // still pass focused runtime settings until Tasks finishes migrating.
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}
