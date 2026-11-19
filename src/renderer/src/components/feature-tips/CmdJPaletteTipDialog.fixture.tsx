import { useSyncExternalStore, type JSX } from 'react'
import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import {
  getTranslationResourceVersion,
  subscribeTranslationResourceVersion
} from '@/i18n/translation-resource-version'
import { CmdJPaletteTipDialog } from './CmdJPaletteTipDialog'

const tip = FEATURE_TIPS.find((item) => item.id === 'cmd-j-palette')
if (!tip) {
  throw new Error('cmd-j-palette feature tip is missing')
}

const render = () => (
  <CmdJPaletteTipDialog
    open
    tip={tip}
    primaryBusy={false}
    onOpenChange={() => {}}
    onPrimaryAction={() => {}}
    onSkip={() => {}}
    onRebindClick={() => {}}
  />
)

export const open = defineFixture({ render })

// Fixtures render outside I18nProvider, so remount once the language loads to localize all copy.
function Relocalized(): JSX.Element {
  const version = useSyncExternalStore(
    subscribeTranslationResourceVersion,
    getTranslationResourceVersion
  )
  return <div key={version}>{render()}</div>
}

export const german = defineFixture({
  interact: () => setRendererUiLanguage('de'),
  render: () => <Relocalized />
})
