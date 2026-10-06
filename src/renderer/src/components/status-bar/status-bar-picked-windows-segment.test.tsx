import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

const window = (usedPercent: number, windowMinutes: number): RateLimitWindow => ({
  usedPercent,
  windowMinutes,
  resetsAt: null,
  resetDescription: null
})

const claude: ProviderRateLimits = {
  provider: 'claude',
  session: window(4, 300),
  weekly: window(68, 10_080),
  fableWeekly: window(100, 10_080),
  updatedAt: 1,
  error: null,
  status: 'ok'
}

const antigravity: ProviderRateLimits = {
  provider: 'antigravity',
  session: window(99, 300),
  weekly: window(98, 10_080),
  buckets: [
    { name: 'Gemini Models · Weekly Limit Remaining', ...window(24, 10_080) },
    { name: 'Gemini Models · Five Hour Limit Remaining', ...window(13, 300) },
    { name: 'Claude and GPT models · Weekly Limit Remaining', ...window(98, 10_080) }
  ],
  updatedAt: 1,
  error: null,
  status: 'ok'
}

describe('ProviderSegment with picked windows', () => {
  it('renders exactly the picked Claude windows by name, even in compact mode', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={claude}
        compact={true}
        display="used"
        mode="compact"
        pickedWindows={['session', 'weekly', 'fableWeekly']}
      />
    )
    expect(markup).toContain('68% used wk')
    expect(markup).toContain('4% used 5h')
    expect(markup).toContain('100% used Fable')
    expect(markup.indexOf('68% used')).toBeLessThan(markup.indexOf('4% used'))
  })

  it('renders only the picked Gemini groups for Antigravity', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravity}
        compact={false}
        display="used"
        mode="verbose"
        pickedWindows={[
          'bucket:Gemini Models · Weekly Limit Remaining',
          'bucket:Gemini Models · Five Hour Limit Remaining'
        ]}
      />
    )
    expect(markup).toContain('Gemini Models')
    expect(markup).toContain('24% used wk')
    expect(markup).toContain('13% used 5h')
    expect(markup).not.toContain('98%')
    expect(markup).not.toContain('Claude and GPT')
  })

  it('renders the default summary unchanged when nothing is picked', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    for (const mode of ['verbose', 'compact'] as const) {
      const withoutPicks = renderToStaticMarkup(
        <ProviderSegment p={claude} compact={false} display="used" mode={mode} />
      )
      const withEmptyPicks = renderToStaticMarkup(
        <ProviderSegment p={claude} compact={false} display="used" mode={mode} pickedWindows={[]} />
      )
      expect(withEmptyPicks).toBe(withoutPicks)
    }
  })

  it('rates urgency by the picked windows, not the tightest overall', async () => {
    const { getUsageTone } = await import('./StatusBarProviderSegment')
    expect(getUsageTone(claude)).toBe('urgent')
    expect(getUsageTone(claude, ['session'])).toBe('normal')
  })
})
