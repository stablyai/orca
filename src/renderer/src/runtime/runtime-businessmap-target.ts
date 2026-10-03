import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from './runtime-rpc-client'

export type RuntimeBusinessmapSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function isTaskSourceRuntimeSettings(
  settings: RuntimeBusinessmapSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getBusinessmapRuntimeTarget(
  settings: RuntimeBusinessmapSettings
): RuntimeClientTarget {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}
