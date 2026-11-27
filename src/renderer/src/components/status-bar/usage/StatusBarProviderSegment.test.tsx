// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import * as usageSections from '../composition/status-bar-usage-sections'
import { ProviderSegment } from './StatusBarProviderSegment'
import { UsageOverflowChip } from './usage-overflow-chip'

vi.mock('../composition/status-bar-usage-sections', async (importOriginal) => {
  const actual = await importOriginal<typeof usageSections>()
  return { ...actual, getStatusBarUsageSections: vi.fn(actual.getStatusBarUsageSections) }
})

const FABLE: ProviderRateLimits = {
  provider: 'claude',
  status: 'ok',
  session: null,
  weekly: null,
  fableWeekly: { usedPercent: 96, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
  updatedAt: 1,
  error: null
}

beforeEach(() => vi.mocked(usageSections.getStatusBarUsageSections).mockClear())
afterEach(cleanup)

function chipTitle(container: HTMLElement): string | null {
  return container.firstElementChild?.getAttribute('title') ?? null
}

it('titles a compact chip from the sections it already derived', () => {
  const { container } = render(
    <ProviderSegment p={FABLE} mode="compact" display="used" hostLabel="build-box" />
  )
  expect(chipTitle(container)).toBe('Claude Fable 96% used\nbuild-box')
  expect(usageSections.getStatusBarUsageSections).toHaveBeenCalledTimes(1)
})

it('shows the reset countdown in the compact status bar when enabled and there is room', () => {
  const previous = useAppStore.getState().statusBarUsageFormat
  const now = Date.UTC(2026, 5, 1)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const limits: ProviderRateLimits = {
    ...FABLE,
    provider: 'codex',
    session: {
      usedPercent: 70,
      windowMinutes: 300,
      resetsAt: now + 65 * 60_000,
      resetDescription: null
    },
    fableWeekly: null
  }
  try {
    useAppStore.setState({ statusBarUsageFormat: { template: '' } })
    const hidden = render(<ProviderSegment p={limits} mode="compact" display="remaining" />)
    expect(hidden.container.textContent).toBe('30%')
    hidden.unmount()

    useAppStore.setState({ statusBarUsageFormat: { template: '', compactResetCountdown: true } })
    const visible = render(<ProviderSegment p={limits} mode="compact" display="remaining" />)
    expect(visible.container.textContent).toBe('30%1h 5m')
    visible.rerender(<ProviderSegment p={limits} mode="compact" display="remaining" compact />)
    expect(visible.container.textContent).toBe('30%')
  } finally {
    cleanup()
    clock.mockRestore()
    useAppStore.setState({ statusBarUsageFormat: previous })
  }
})

it('builds no tooltip for an off-layout measuring chip', () => {
  const { container } = render(
    <ProviderSegment p={FABLE} mode="compact" display="used" measuring countdownActive={false} />
  )
  expect(chipTitle(container)).toBeNull()
  expect(usageSections.getStatusBarUsageSections).toHaveBeenCalledTimes(1)
})

it('keeps naming hidden providers in the overflow chip tooltip', () => {
  const { container } = render(
    <UsageOverflowChip hidden={[FABLE]} providerCount={2} display="used" />
  )
  expect(chipTitle(container)).toBe('Also: Claude Fable 96% used')
})
