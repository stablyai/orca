import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../search/settings-search'

export const getChatSpeechTitle = (t: Translate = translate): string =>
  t('components.settings.nativeChat.speechTitle', 'Speech')

export const getChatSpeechEntriesByKey = createLocalizedCatalog(
  () =>
    ({
      enabled: {
        targetSectionId: 'chat-speech',
        title: translate('components.settings.nativeChat.speechEnabledTitle', 'Speak replies'),
        description: translate(
          'components.settings.nativeChat.speechEnabledCopy',
          'Show a Speak button on a finished agent reply.'
        ),
        keywords: [
          translate('components.settings.nativeChat.speechSearchReadAloud', 'read aloud'),
          translate('components.settings.nativeChat.speechSearchTts', 'text to speech')
        ]
      },
      engine: {
        targetSectionId: 'chat-speech-engine',
        title: translate('components.settings.nativeChat.speechEngineTitle', 'Voice engine'),
        description: translate(
          'components.settings.nativeChat.speechEngineCopy',
          "Neural voices need the internet and send the reply text to Microsoft's speech service. They speak English words inside Russian."
        ),
        keywords: [
          translate('components.settings.nativeChat.speechSearchNeural', 'neural'),
          translate('components.settings.nativeChat.speechSearchSvetlana', 'Svetlana'),
          translate('components.settings.nativeChat.speechSearchDmitry', 'Dmitry')
        ]
      },
      rate: {
        targetSectionId: 'chat-speech-rate',
        title: translate('components.settings.nativeChat.speechRateTitle', 'Speaking speed'),
        description: translate(
          'components.settings.nativeChat.speechRateCopy',
          'How fast a reply is read.'
        ),
        keywords: [
          translate('components.settings.nativeChat.speechSearchSlower', 'slower'),
          translate('components.settings.nativeChat.speechSearchFaster', 'faster')
        ]
      },
      auto: {
        targetSectionId: 'chat-speech-auto',
        title: translate('components.settings.nativeChat.speechAutoTitle', 'Speak new replies'),
        description: translate(
          'components.settings.nativeChat.speechAutoCopy',
          'Read an agent reply when that turn finishes.'
        ),
        keywords: [translate('components.settings.nativeChat.speechSearchAuto', 'automatic')]
      }
    }) satisfies Record<string, SettingsSearchEntry>
)

export function getChatSpeechSearchEntries(
  t?: Translate,
  options: { includeEngine?: boolean } = {}
): SettingsSearchEntry[] {
  const entries = getChatSpeechEntriesByKey()
  return [
    { title: getChatSpeechTitle(t) },
    entries.enabled,
    ...(options.includeEngine === false ? [] : [entries.engine]),
    entries.rate,
    entries.auto
  ]
}
