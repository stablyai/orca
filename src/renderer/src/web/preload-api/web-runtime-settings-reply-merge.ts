import type { GlobalSettings } from '../../../../shared/global-settings-types'

/**
 * A paired host's `settings.update` reply, ready to merge into browser settings. The host projects
 * only its launch recipes under `sourceControlAi`, so those overlay per action and browser-local
 * fields (text recipes, custom actions) survive.
 */
export function runtimeReplyForLocalMerge(
  local: GlobalSettings,
  reply: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const { worktreeVisibilityDefaults: _worktreeVisibilityDefaults, ...runtimeSettings } = reply
  if (!runtimeSettings.sourceControlAi || !local.sourceControlAi) {
    return runtimeSettings
  }
  return {
    ...runtimeSettings,
    sourceControlAi: {
      ...local.sourceControlAi,
      actions: { ...local.sourceControlAi.actions, ...runtimeSettings.sourceControlAi.actions }
    }
  }
}
