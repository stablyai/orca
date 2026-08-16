import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { getActiveRuntimeTarget } from './runtime-rpc-client'

export type RuntimeJiraSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function isTaskSourceRuntimeSettings(settings: RuntimeJiraSettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getJiraRuntimeTarget(
  settings: RuntimeJiraSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}
