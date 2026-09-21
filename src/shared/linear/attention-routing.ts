import type { TaskSourceContext } from '../task-source-context'
import type { GlobalSettings } from '../global-settings-types'

export function isLocalLinearAttentionSource(
  context: Pick<TaskSourceContext, 'hostId'> | null | undefined,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
): boolean {
  return context
    ? context.hostId === 'local'
    : settings !== null && !settings.activeRuntimeEnvironmentId
}
