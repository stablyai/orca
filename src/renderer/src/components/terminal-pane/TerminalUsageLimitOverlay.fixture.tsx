import { useTranslation } from 'react-i18next'
import { getDefaultSettings } from '../../../../shared/constants'
import { i18n, loadRendererUiLanguage, translate } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { TerminalUsageLimitOverlay } from './TerminalUsageLimitOverlay'

export const knownReset = defineFixture({
  width: 480,
  render: () => (
    <div className="relative h-96 bg-background">
      <TerminalUsageLimitOverlay
        title="Claude hit its weekly limit."
        body={'It resets at Nov 4, 2026, 9:00 AM.\nSend “continue” to Claude to try again.'}
        pending={false}
        onContinue={() => {}}
      />
    </div>
  )
})

export const unknownReset = defineFixture({
  width: 320,
  render: () => (
    <div className="relative h-96 bg-background">
      <TerminalUsageLimitOverlay
        title="Codex hit its usage limit."
        body={'Reset time unavailable.\nSend “continue” to Codex to try again.'}
        pending={false}
        onContinue={() => {}}
      />
    </div>
  )
})

function TranslatedPending() {
  useTranslation()
  return (
    <div className="relative h-96 bg-background">
      <TerminalUsageLimitOverlay
        title={translate(
          'components.native-chat.failureWords.usageLimitReachedNamed',
          '{{agent}} hit its {{window}} limit.',
          {
            agent: 'Claude',
            window: translate(
              'components.native-chat.failureWords.usageLimitWindowWeekly',
              'weekly'
            )
          }
        )}
        body={`${translate('terminal.usageLimit.resetUnknown', 'Reset time unavailable.')}\n${translate('terminal.usageLimit.explanation', 'Send “continue” to {{agent}} to try again.', { agent: 'Claude' })}`}
        pending
        onContinue={() => {}}
      />
    </div>
  )
}
async function germanReady() {
  await loadRendererUiLanguage('de')
  await i18n.changeLanguage('de')
}
export const translatedPending = defineFixture({
  width: 320,
  store: { settings: { ...getDefaultSettings(), uiLanguage: 'de' } },
  render: () => <TranslatedPending />,
  interact: germanReady
})
export const translatedCollapsed = defineFixture({
  ...translatedPending,
  width: 240,
  interact: async (frame) => {
    await germanReady()
    frame.querySelector<HTMLButtonElement>('button[aria-label="Minimieren"]')?.click()
  }
})
