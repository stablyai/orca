import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'
import { NATIVE_CHAT_RESUME_SETTING_SECTION_ID } from './native-chat-resume-setting-target'

export const getChatBehaviorTitle = (): string =>
  translate('components.settings.nativeChat.behaviorTitle', 'Behavior')

export const getChatBehaviorEntriesByKey = createLocalizedCatalog(() => ({
  resumeOnRestart: {
    targetSectionId: NATIVE_CHAT_RESUME_SETTING_SECTION_ID,
    title: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.resumeTitle',
      'Resume working chats automatically after a restart'
    ),
    description: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.resumeCopy',
      'When Orca quits or installs an update, chats that were working are automatically resumed when Orca is reopened.'
    ),
    keywords: [
      translate('components.settings.nativeChat.resumeSearchUpdate', 'update'),
      translate('components.settings.nativeChat.resumeSearchRelaunch', 'relaunch')
    ]
  },
  queueFollowUps: {
    targetSectionId: 'chat-queue-follow-ups',
    title: translate('components.settings.nativeChat.followUpBehaviorTitle', 'Queue follow-ups'),
    description: translate(
      'components.settings.nativeChat.followUpBehaviorCopy',
      'Messages sent while the agent works wait as cards until the turn ends, instead of going into the running turn. Cmd/Ctrl+Enter does the opposite for one message.'
    ),
    keywords: [
      translate('components.settings.nativeChat.queueSearchQueue', 'queue'),
      translate('components.settings.nativeChat.queueSearchSteer', 'steer')
    ]
  },
  linkPreviews: {
    targetSectionId: 'chat-link-previews',
    title: translate('components.settings.nativeChat.linkPreviewsTitle', 'Link previews'),
    description: translate(
      'components.settings.nativeChat.linkPreviewsCopy',
      'Hovering a web link shows a preview card. Orca fetches the page to build it, so the site can see the request.'
    ),
    keywords: [
      translate('components.settings.nativeChat.linkPreviewsSearchUnfurl', 'unfurl'),
      translate('components.settings.nativeChat.linkPreviewsSearchHover', 'hover card')
    ]
  },
  shellEnvironment: {
    targetSectionId: 'chat-shell-environment',
    title: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.shellEnvTitle',
      'Use your shell environment'
    ),
    description: translate(
      'auto.components.settings.ExperimentalPane.nativeChat.shellEnvCopy',
      'Codex and Claude chats start with every variable your login shell exports, the same as a terminal. Turn off to choose which ones they get.'
    ),
    keywords: [
      translate('components.settings.nativeChat.shellEnvSearchVariables', 'environment variables'),
      translate('components.settings.nativeChat.shellEnvSearchPath', 'PATH'),
      translate('components.settings.nativeChat.shellEnvSearchProxy', 'proxy')
    ]
  }
}))

export function getChatBehaviorSearchEntries(): SettingsSearchEntry[] {
  return [{ title: getChatBehaviorTitle() }, ...Object.values(getChatBehaviorEntriesByKey())]
}
