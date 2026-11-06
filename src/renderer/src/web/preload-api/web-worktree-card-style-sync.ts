import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isWorktreeCardStyle } from '../../../../shared/worktree/card-style'
import { webRuntimeState } from './web-runtime-session'

type CardStyleSettings = Pick<
  Partial<GlobalSettings>,
  'experimentalNewWorktreeCardStyle' | 'worktreeCardStyle'
>

/** Mirror the host's card style, and remember whether this host accepts the three-way field. */
export function readHostWorktreeCardStyle(
  host: CardStyleSettings,
  environmentId: string,
  environmentStillActive: boolean
): CardStyleSettings {
  if (environmentStillActive) {
    webRuntimeState.worktreeCardStyleRuntimeEnvironmentId = isWorktreeCardStyle(
      host.worktreeCardStyle
    )
      ? environmentId
      : null
  }
  return {
    ...(typeof host.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: host.experimentalNewWorktreeCardStyle }
      : {}),
    ...(isWorktreeCardStyle(host.worktreeCardStyle)
      ? { worktreeCardStyle: host.worktreeCardStyle }
      : {})
  }
}

/** Older hosts reject unknown setting keys, so send the style only to a host that advertised it. */
export function hostWorktreeCardStyleUpdate(
  updates: CardStyleSettings,
  environmentId: string
): CardStyleSettings {
  return {
    ...(typeof updates.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: updates.experimentalNewWorktreeCardStyle }
      : {}),
    ...(isWorktreeCardStyle(updates.worktreeCardStyle) &&
    webRuntimeState.worktreeCardStyleRuntimeEnvironmentId === environmentId
      ? { worktreeCardStyle: updates.worktreeCardStyle }
      : {})
  }
}
