import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { getActiveRuntimeTarget } from './runtime-rpc-client'

export type RuntimeShortcutSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function isTaskSourceRuntimeSettings(
  settings: RuntimeShortcutSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getShortcutRuntimeTarget(
  settings: RuntimeShortcutSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}
