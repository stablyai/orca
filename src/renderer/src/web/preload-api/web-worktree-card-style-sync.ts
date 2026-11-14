import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { webRuntimeState } from './web-runtime-session'

type CardStyleSettings = Pick<
  Partial<GlobalSettings>,
  'experimentalNewWorktreeCardStyle' | 'worktreeCardDetailsRow' | 'compactWorktreeCards'
>

/** Mirror card preferences and remember whether this host accepts the details-row field. */
export function read(
  host: CardStyleSettings,
  environmentId: string,
  environmentStillActive: boolean
): CardStyleSettings {
  if (environmentStillActive) {
    webRuntimeState.worktreeCardDetailsRowRuntimeEnvironmentId =
      typeof host.worktreeCardDetailsRow === 'boolean' ? environmentId : null
  }
  return {
    ...(environmentStillActive && typeof host.worktreeCardDetailsRow === 'boolean'
      ? { worktreeCardDetailsRow: host.worktreeCardDetailsRow }
      : {}),
    ...(typeof host.compactWorktreeCards === 'boolean'
      ? { compactWorktreeCards: host.compactWorktreeCards }
      : {}),
    ...(typeof host.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: host.experimentalNewWorktreeCardStyle }
      : {})
  }
}

/** Older hosts reject unknown setting keys; only send the details preference when advertised. */
export function updates(patch: CardStyleSettings, environmentId: string): CardStyleSettings {
  return {
    ...(typeof patch.worktreeCardDetailsRow === 'boolean' &&
    webRuntimeState.worktreeCardDetailsRowRuntimeEnvironmentId === environmentId
      ? { worktreeCardDetailsRow: patch.worktreeCardDetailsRow }
      : {}),
    ...(typeof patch.compactWorktreeCards === 'boolean'
      ? { compactWorktreeCards: patch.compactWorktreeCards }
      : {}),
    ...(typeof patch.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: patch.experimentalNewWorktreeCardStyle }
      : {})
  }
}
