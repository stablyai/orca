import { defineFixture } from '../../component-fixtures/component-fixture'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BotRowLine } from './bot-row-activity-line'
import { BotRowLineText } from './BotRowActivityLine'

const LINES: { id: string; line: BotRowLine }[] = [
  { id: 'needs-one', line: { kind: 'needYouElsewhere', count: 1 } },
  { id: 'needs-many', line: { kind: 'needYouElsewhere', count: 21 } },
  { id: 'working', line: { kind: 'workingElsewhere', count: 3 } },
  { id: 'replying', line: { kind: 'replying', place: { label: '#general', source: 'slack' } } }
]

const paint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** The row's second line kept mounted across a pt -> zh switch of settings.uiLanguage. */
export const languageSwitch = defineFixture({
  width: 252,
  render: () => (
    <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
      {LINES.map(({ id, line }) => (
        <span key={id}>
          <BotRowLineText line={line} now={0} />
        </span>
      ))}
    </div>
  ),
  interact: async (frame) => {
    for (const locale of ['pt', 'zh'] as const) {
      await loadRendererUiLanguage(locale)
      // The fixture frame's I18nProvider switches i18n from the saved preference, as the app does.
      useAppStore.setState(({ settings }) =>
        settings ? { settings: { ...settings, uiLanguage: locale } } : {}
      )
      for (let attempt = 0; i18n.language !== locale && attempt < 120; attempt++) {
        await paint()
      }
      if (i18n.language !== locale) {
        throw new Error(`Fixture did not switch to ${locale}`)
      }
      await paint()
      await paint()
    }
    const state = document.createElement('p')
    state.className = 'text-xs'
    state.textContent = `Active locale: ${i18n.language}`
    frame.append(state)
  }
})
