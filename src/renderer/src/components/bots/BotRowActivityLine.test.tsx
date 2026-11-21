// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import type { BotRowLine } from './bot-row-activity-line'
import { BotHoverLatestLine, BotRowLineText } from './BotRowActivityLine'

// React Compiler memoizes these components on their props, so a language switch must reach their
// words through useTranslate() rather than module translate(); each case keeps one mount across it.
// A sentinel catalog stands in for the real one, so only the switch is under test, not its copy.

beforeAll(() => {
  i18n.addResourceBundle(
    'zh',
    'translation',
    {
      bots: {
        panel: {
          needYou_other: 'switched need {{count}}',
          working_other: 'switched work {{count}}'
        },
        row: { replyingIn: 'switched reply {{place}}' }
      }
    },
    false,
    true
  )
})

afterAll(() => {
  i18n.removeResourceBundle('zh', 'translation')
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  vi.unstubAllGlobals()
})

async function switchToZh(): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage('zh')
  })
}

function renderInScope(node: React.ReactNode): void {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  render(<TranslationScopeProvider>{node}</TranslationScopeProvider>)
}

it.each<[string, BotRowLine, string, string]>([
  ['needs you', { kind: 'needYouElsewhere', count: 2 }, '2 need you', 'switched need 2'],
  ['working', { kind: 'workingElsewhere', count: 3 }, '3 working', 'switched work 3'],
  [
    'replying in a place',
    { kind: 'replying', place: { label: '#general', source: 'slack' } },
    'Replying in #general',
    'switched reply #general'
  ]
])(
  'the row line (%s) follows a language switch without remounting',
  async (_, line, before, after) => {
    renderInScope(
      <p data-testid="line">
        <BotRowLineText line={line} now={0} />
      </p>
    )
    expect(screen.getByTestId('line').textContent).toBe(before)

    await switchToZh()

    expect(screen.getByTestId('line').textContent).toBe(after)
  }
)

it('the hover card line follows a language switch without remounting', async () => {
  renderInScope(<BotHoverLatestLine line={{ kind: 'needYouElsewhere', count: 2 }} now={0} />)
  expect(screen.getByText('2 need you')).toBeTruthy()

  await switchToZh()

  expect(screen.getByText('switched need 2')).toBeTruthy()
})

it('the hover card age follows a language switch without remounting', async () => {
  const now = 10 * 60_000
  renderInScope(
    <p data-testid="hover">
      <BotHoverLatestLine
        line={{ kind: 'activity', place: null, text: 'Shipped it', at: now - 5 * 60_000 }}
        now={now}
      />
    </p>
  )
  expect(screen.getByTestId('hover').textContent).toContain('5 minutes ago')

  await switchToZh()

  expect(screen.getByTestId('hover').textContent).not.toContain('5 minutes ago')
})
