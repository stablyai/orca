// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  // Why Date.now default: the existing label tests build resetsAt from the wall clock, so the
  // stub must track it; individual tests override with mockReturnValueOnce to pin the wiring.
  useResetCountdownClock: vi.fn(() => Date.now())
}))

vi.mock('@/hooks/useResetCountdownClock', () => ({
  useResetCountdownClock: mocks.useResetCountdownClock
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (result, [key, value]) => result.replace(`{{${key}}}`, value),
      fallback
    )
}))

import { ProviderSegment } from './StatusBarProviderSegment'

const antigravity: ProviderRateLimits = {
  provider: 'antigravity',
  session: null,
  weekly: null,
  buckets: [
    {
      id: 'gemini-5h',
      name: 'Five Hour Limit Remaining',
      groupName: 'Gemini Models',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    {
      id: 'gemini-weekly',
      name: 'Weekly Limit Remaining',
      groupName: 'Gemini Models',
      usedPercent: 1,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    {
      id: '3p-5h',
      name: 'Five Hour Limit Remaining',
      groupName: 'Claude and GPT models',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    {
      id: '3p-weekly',
      name: 'Weekly Limit Remaining',
      groupName: 'Claude and GPT models',
      usedPercent: 0,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    }
  ],
  updatedAt: 1,
  error: null,
  status: 'ok'
}

describe('Antigravity status summary', () => {
  it.each([
    ['used', ['0% used', '1% used']],
    ['remaining', ['100% left', '99% left']]
  ] as const)(
    'labels each pool and falls back to window length in %s mode',
    (display, expected) => {
      const markup = renderToStaticMarkup(
        <ProviderSegment p={antigravity} compact={false} display={display} mode="verbose" />
      )

      for (const value of expected) {
        expect(markup).toContain(value)
      }
      expect(markup).toContain('G')
      expect(markup).toContain('C/G')
      // Why: without a reset time the chip names the window, as it does for Claude and Codex.
      expect(markup).toContain('5h')
      expect(markup).toContain('wk')
      expect(markup).not.toContain('Limit Remaining')
    }
  )

  it('shows reset durations after detailed menu-bar percentages', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          ...antigravity,
          buckets: antigravity.buckets!.map((bucket) => ({
            ...bucket,
            resetsAt:
              Date.now() + (bucket.windowMinutes === 300 ? 5 * 60 * 60_000 : 4 * 24 * 60 * 60_000)
          }))
        }}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toMatch(/0% used \d+h/)
    expect(markup).toMatch(/1% used \d+d/)
    expect(markup).not.toContain('Session')
    expect(markup).not.toContain('Weekly')
  })

  it('selects the tightest window independently for each compact group', () => {
    const now = Date.now()
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          ...antigravity,
          buckets: [
            { ...antigravity.buckets![0], usedPercent: 80, resetsAt: now + 2 * 60 * 60_000 },
            { ...antigravity.buckets![1], usedPercent: 10, resetsAt: now + 5 * 24 * 60 * 60_000 },
            { ...antigravity.buckets![2], usedPercent: 15, resetsAt: now + 2 * 60 * 60_000 },
            { ...antigravity.buckets![3], usedPercent: 60, resetsAt: now + 6 * 24 * 60 * 60_000 }
          ]
        }}
        compact={false}
        display="used"
        mode="compact"
      />
    )

    expect(markup).toMatch(/G.*80% used.*(?:1h|2h)/)
    expect(markup).toMatch(/C\/G.*60% used.*(?:5d|6d)/)
    expect(markup.indexOf('80% used')).toBeLessThan(markup.search(/(?:1h|2h)/))
    expect(markup).not.toContain('wk')
    expect(markup).not.toContain('5h')
  })

  it('keeps the selected window in Used and Remaining modes', () => {
    const p = {
      ...antigravity,
      buckets: antigravity.buckets!.map((bucket) => ({
        ...bucket,
        usedPercent: bucket.windowMinutes === 300 ? 80 : 20,
        resetsAt:
          Date.now() + (bucket.windowMinutes === 300 ? 2 * 60 * 60_000 : 5 * 24 * 60 * 60_000)
      }))
    }
    const used = renderToStaticMarkup(
      <ProviderSegment p={p} compact={false} display="used" mode="compact" />
    )
    const remaining = renderToStaticMarkup(
      <ProviderSegment p={p} compact={false} display="remaining" mode="compact" />
    )
    expect(used).toContain('80% used')
    expect(remaining).toContain('20% left')
    expect(used).toMatch(/80% used.*(?:1h|2h)/)
    expect(remaining).toMatch(/20% left.*(?:1h|2h)/)
  })

  it('renders reset labels from the countdown clock, not render-time Date.now()', () => {
    mocks.useResetCountdownClock.mockClear()
    const clockNow = 1_000_000_000
    mocks.useResetCountdownClock.mockReturnValueOnce(clockNow)
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          ...antigravity,
          buckets: [
            { ...antigravity.buckets![0], usedPercent: 80, resetsAt: clockNow + 2 * 60 * 60_000 }
          ]
        }}
        compact={false}
        display="used"
        mode="compact"
      />
    )

    expect(markup).toContain('80% used 2h')
    expect(mocks.useResetCountdownClock).toHaveBeenCalledOnce()
  })
})
