import { useSyncExternalStore, type JSX } from 'react'
import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import type { BuiltInUiLanguage } from '../../../../shared/i18n/ui-language'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import {
  getTranslationResourceVersion,
  subscribeTranslationResourceVersion
} from '@/i18n/translation-resource-version'
import { VoiceDictationTipDialog } from './VoiceDictationTipDialog'

const tip = FEATURE_TIPS.find((item) => item.id === 'voice-dictation')
if (!tip) {
  throw new Error('voice-dictation feature tip is missing')
}

const render = () => (
  <VoiceDictationTipDialog
    open
    tip={tip}
    primaryBusy={false}
    onOpenChange={() => {}}
    onPrimaryAction={() => {}}
    onSkip={() => {}}
    onVoiceSettingsClick={() => {}}
  />
)

export const open = defineFixture({ render })

// The user cleared the dictation shortcut: the demo plays without a keycap.
export const shortcutUnassigned = defineFixture({
  store: { keybindings: { 'voice.dictation': [] } },
  render
})

// Fixtures render outside I18nProvider, so remount once the language loads to localize all copy.
function Relocalized(): JSX.Element {
  const version = useSyncExternalStore(
    subscribeTranslationResourceVersion,
    getTranslationResourceVersion
  )
  return <div key={version}>{render()}</div>
}

// Translated demo copy has to fit the same card and pill as English.
const localized = (language: BuiltInUiLanguage) =>
  defineFixture({
    interact: () => setRendererUiLanguage(language),
    render: () => <Relocalized />
  })

export const german = localized('de')
export const spanish = localized('es')
export const french = localized('fr')
export const japanese = localized('ja')
export const korean = localized('ko')
export const portuguese = localized('pt')
export const russian = localized('ru')
export const turkish = localized('tr')
export const chinese = localized('zh')
export const chineseTraditional = localized('zh-Hant')
