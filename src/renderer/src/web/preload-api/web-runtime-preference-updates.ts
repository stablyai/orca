import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeWorkspaceTitleLanguage } from '../../../../shared/workspace-title-language'
import { normalizePRBotAuthorOverrides } from '../../../../shared/source-control/review-comments/pr-bot-author-overrides'

export function runtimePreferenceUpdates(
  settings: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const updates: Partial<GlobalSettings> = {}
  for (const key of ['experimentalNewWorktreeCardStyle', 'compactWorktreeCards'] as const) {
    if (typeof settings[key] === 'boolean') {
      updates[key] = settings[key]
    }
  }
  for (const key of ['minimaxGroupId', 'minimaxUsageModels'] as const) {
    if (typeof settings[key] === 'string') {
      updates[key] = settings[key]
    }
  }
  if (settings.minimaxEndpoint === 'overseas' || settings.minimaxEndpoint === 'cn') {
    updates.minimaxEndpoint = settings.minimaxEndpoint
  }
  if (Array.isArray(settings.prBotAuthorOverrides)) {
    updates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(settings.prBotAuthorOverrides)
  }
  if (settings.workspaceTitleLanguage !== undefined) {
    updates.workspaceTitleLanguage = normalizeWorkspaceTitleLanguage(
      settings.workspaceTitleLanguage
    )
  }
  return updates
}
