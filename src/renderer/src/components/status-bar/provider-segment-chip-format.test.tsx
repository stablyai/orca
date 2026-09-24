import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { STATUS_BAR_USAGE_CHIP_PRESETS } from '../../../../shared/status-bar-usage-chip-format'

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

const NOW = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function claudeLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: {
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: NOW + 3 * HOUR + 54 * MIN,
      resetDescription: null
    },
    weekly: null,
    updatedAt: NOW,
    error: null,
    status: 'ok'
  }
}

async function render(
  chipFormat: (typeof STATUS_BAR_USAGE_CHIP_PRESETS)[keyof typeof STATUS_BAR_USAGE_CHIP_PRESETS]
): Promise<string> {
  const { ProviderSegment } = await import('./StatusBar')
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  try {
    return renderToStaticMarkup(
      <ProviderSegment
        p={claudeLimits()}
        compact={false}
        display="used"
        mode="verbose"
        chipFormat={chipFormat}
      />
    )
  } finally {
    dateNow.mockRestore()
  }
}

describe('ProviderSegment chip format', () => {
  it('renders the long-standing shape by default', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      // No chipFormat prop at all — this is what every existing caller gets,
      // and what an upgraded install must keep seeing.
      const markup = renderToStaticMarkup(
        <ProviderSegment p={claudeLimits()} compact={false} display="used" mode="verbose" />
      )
      expect(markup).toContain('42% used 3h 54m')
    } finally {
      dateNow.mockRestore()
    }
  })

  it('joins the pair with a comma and tightens the duration when compact', async () => {
    const markup = await render(STATUS_BAR_USAGE_CHIP_PRESETS.compact)
    expect(markup).toContain('42%, 3h54m')
    // The word moves to the tooltip, so it must not survive in the chip.
    expect(markup).not.toContain('used')
  })

  it('drops the countdown entirely when percent-only', async () => {
    const markup = await render(STATUS_BAR_USAGE_CHIP_PRESETS.percentOnly)
    expect(markup).toContain('42%')
    expect(markup).not.toContain('3h')
    expect(markup).not.toContain(',')
  })

  it('never wraps a chip across lines', async () => {
    // Why: flex used to break the chip at the space inside a value, stranding
    // the countdown on a second row under its own percentage.
    for (const preset of Object.values(STATUS_BAR_USAGE_CHIP_PRESETS)) {
      expect(await render(preset)).toContain('whitespace-nowrap')
    }
  })
})

describe('ProviderSegment usage bars', () => {
  it('draws the bar by default and hides it when the preference is off', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const withBar = renderToStaticMarkup(
      <ProviderSegment p={claudeLimits()} compact={false} display="used" mode="verbose" />
    )
    const withoutBar = renderToStaticMarkup(
      <ProviderSegment
        p={claudeLimits()}
        compact={false}
        display="used"
        mode="verbose"
        barsVisible={false}
      />
    )
    expect(withBar).toContain('data-usage-bar')
    expect(withoutBar).not.toContain('data-usage-bar')
    // Turning the bar off must not take the reading with it.
    expect(withoutBar).toContain('42% used')
  })
})
