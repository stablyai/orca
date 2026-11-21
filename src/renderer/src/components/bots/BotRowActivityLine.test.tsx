// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import zh from '@/i18n/locales/zh.json'
import { i18n } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import type { BotRowLine } from './bot-row-activity-line'
import { BotHoverLatestLine, BotRowLineText } from './BotRowActivityLine'

// React Compiler memoizes these components on their props, so a language switch must reach their
// words through useTranslate() rather than module translate(); each case keeps one mount across it.

beforeAll(() => {
  i18n.addResourceBundle('zh', 'translation', zh)
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  vi.unstubAllGlobals()
})

async function switchLanguage(language: string): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(language)
  })
}

function renderInScope(node: React.ReactNode): void {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  render(<TranslationScopeProvider>{node}</TranslationScopeProvider>)
}

it.each<[string, BotRowLine, string, string]>([
  ['needs you', { kind: 'needYouElsewhere', count: 2 }, '2 need you', '2 项需要你处理'],
  ['working', { kind: 'workingElsewhere', count: 3 }, '3 working', '3 项工作进行中'],
  [
    'replying in a place',
    { kind: 'replying', place: { label: '#general', source: 'slack' } },
    'Replying in #general',
    '正在 #general 中回复'
  ]
])(
  'the row line (%s) follows a language switch without remounting',
  async (_, line, en, zhText) => {
    renderInScope(
      <p data-testid="line">
        <BotRowLineText line={line} now={0} />
      </p>
    )
    expect(screen.getByTestId('line').textContent).toBe(en)

    await switchLanguage('zh')

    expect(screen.getByTestId('line').textContent).toBe(zhText)
  }
)

it('the hover card line follows a language switch without remounting', async () => {
  const now = 10 * 60_000
  renderInScope(<BotHoverLatestLine line={{ kind: 'needYouElsewhere', count: 2 }} now={now} />)
  expect(screen.getByText('2 need you')).toBeTruthy()

  await switchLanguage('zh')

  expect(screen.getByText('2 项需要你处理')).toBeTruthy()
})

it('the hover card age follows a language switch without remounting', async () => {
  const now = 10 * 60_000
  renderInScope(
    <BotHoverLatestLine
      line={{ kind: 'activity', place: null, text: 'Shipped it', at: now - 5 * 60_000 }}
      now={now}
    />
  )
  const enAge = formatUiRelativeTime(-5 * 60_000)
  expect(screen.getByText(`${enAge} ·`, { exact: false })).toBeTruthy()

  await switchLanguage('zh')

  const zhAge = formatUiRelativeTime(-5 * 60_000)
  expect(zhAge).not.toBe(enAge)
  expect(screen.getByText(`${zhAge} ·`, { exact: false })).toBeTruthy()
})
