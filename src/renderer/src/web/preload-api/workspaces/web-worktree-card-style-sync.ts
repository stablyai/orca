import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { webRuntimeState } from '../../runtime/client/web-runtime-session'

type CardStyleSettings = Pick<
  Partial<GlobalSettings>,
  | 'experimentalNewWorktreeCardStyle'
  | 'worktreeCardDetailsRow'
  | 'compactWorktreeCards'
  | 'hidePrimaryWorktreeMarker'
  | 'worktreeIndentPx'
>

/** Mirror card preferences and remember which host accepts each optional field. */
export function read(
  host: CardStyleSettings,
  environmentId: string,
  environmentStillActive: boolean
): CardStyleSettings {
  if (environmentStillActive) {
    webRuntimeState.worktreeCardDetailsRowRuntimeEnvironmentId =
      typeof host.worktreeCardDetailsRow === 'boolean' ? environmentId : null
    webRuntimeState.hidePrimaryWorktreeMarkerRuntimeEnvironmentId =
      typeof host.hidePrimaryWorktreeMarker === 'boolean' ? environmentId : null
    webRuntimeState.worktreeIndentPxRuntimeEnvironmentId =
      typeof host.worktreeIndentPx === 'number' ? environmentId : null
  }
  return {
    ...(environmentStillActive && typeof host.worktreeCardDetailsRow === 'boolean'
      ? { worktreeCardDetailsRow: host.worktreeCardDetailsRow }
      : {}),
    ...(environmentStillActive && typeof host.hidePrimaryWorktreeMarker === 'boolean'
      ? { hidePrimaryWorktreeMarker: host.hidePrimaryWorktreeMarker }
      : {}),
    ...(environmentStillActive && typeof host.worktreeIndentPx === 'number'
      ? { worktreeIndentPx: host.worktreeIndentPx }
      : {}),
    ...(typeof host.compactWorktreeCards === 'boolean'
      ? { compactWorktreeCards: host.compactWorktreeCards }
      : {}),
    ...(typeof host.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: host.experimentalNewWorktreeCardStyle }
      : {})
  }
}

/** Older hosts reject unknown setting keys; only send fields whose support was advertised. */
export function updates(patch: CardStyleSettings, environmentId: string): CardStyleSettings {
  return {
    ...(typeof patch.worktreeCardDetailsRow === 'boolean' &&
    webRuntimeState.worktreeCardDetailsRowRuntimeEnvironmentId === environmentId
      ? { worktreeCardDetailsRow: patch.worktreeCardDetailsRow }
      : {}),
    ...(typeof patch.hidePrimaryWorktreeMarker === 'boolean' &&
    webRuntimeState.hidePrimaryWorktreeMarkerRuntimeEnvironmentId === environmentId
      ? { hidePrimaryWorktreeMarker: patch.hidePrimaryWorktreeMarker }
      : {}),
    ...(typeof patch.worktreeIndentPx === 'number' &&
    webRuntimeState.worktreeIndentPxRuntimeEnvironmentId === environmentId
      ? { worktreeIndentPx: patch.worktreeIndentPx }
      : {}),
    ...(typeof patch.compactWorktreeCards === 'boolean'
      ? { compactWorktreeCards: patch.compactWorktreeCards }
      : {}),
    ...(typeof patch.experimentalNewWorktreeCardStyle === 'boolean'
      ? { experimentalNewWorktreeCardStyle: patch.experimentalNewWorktreeCardStyle }
      : {})
  }
}
