import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ClaudeFlaggedRequestAction } from '../../../../../../shared/agent-launch/startup/claude-flagged-request-launch'
import { searchKeywords } from '../../search/settings-search-keywords'

export function getClaudeFlaggedRequestTitle(t: Translate = translate): string {
  return t('settings.agents.claudeFlaggedRequest.title', 'When Claude flags a request')
}

export function getClaudeFlaggedRequestDescription(t: Translate = translate): string {
  return t(
    'settings.agents.claudeFlaggedRequest.description',
    'When a safety check flags a request, Claude can re-run it on its fallback model and keep using that model, or end the turn with an error. Applies to Claude chats and terminals started after you change it.'
  )
}

export function getClaudeFlaggedRequestActionLabel(
  action: ClaudeFlaggedRequestAction,
  t: Translate = translate
): string {
  return action === 'stop'
    ? t('settings.agents.claudeFlaggedRequest.stop', 'Stop with an error')
    : t('settings.agents.claudeFlaggedRequest.switchModel', "Switch to Claude's fallback model")
}

export function getClaudeFlaggedRequestUnsupported(host: string, t: Translate = translate): string {
  return t(
    'settings.agents.claudeFlaggedRequest.unsupported',
    'Update Orca on {{host}} to change this setting there.',
    { host }
  )
}

export function getClaudeFlaggedRequestUpdateFailed(host: string): string {
  return translate(
    'settings.agents.claudeFlaggedRequest.updateFailed',
    'Could not update the setting on {{host}}.',
    { host }
  )
}

export function getClaudeFlaggedRequestSearchKeywords(): string[] {
  return searchKeywords([
    'claude',
    { key: 'settings.agents.claudeFlaggedRequest.searchFallback', fallback: 'fallback' },
    { key: 'settings.agents.claudeFlaggedRequest.searchModel', fallback: 'model' },
    { key: 'settings.agents.claudeFlaggedRequest.searchRefusal', fallback: 'refusal' },
    { key: 'settings.agents.claudeFlaggedRequest.searchSafety', fallback: 'safety' }
  ])
}
