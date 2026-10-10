import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { getUsageTone, ProviderSegment, UsageOverflowChip } from './StatusBarProviderSegment'
import {
  getTightestUsageSection,
  getUsageHeadlineSection,
  UsageRosterPanel,
  UsageRow
} from './UsageRosterPanel'
import { pickCollapsedUsageChips } from './status-bar-usage-collapse'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 0 }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}))
vi.mock('@/components/settings/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => null
}))

function windowAt(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: 43_200, resetsAt: null, resetDescription: null }
}

function cursorPools(primary: number, other: number, onDemand?: number): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    monthly: windowAt(12),
    buckets: [
      { name: 'Cursor Models', ...windowAt(primary) },
      { name: 'Other Models', ...windowAt(other) },
      ...(onDemand === undefined ? [] : [{ name: 'On-demand', ...windowAt(onDemand) }])
    ],
    updatedAt: 0,
    error: null,
    status: 'ok'
  }
}

describe('Cursor compact usage headline', () => {
  it.each([0, 7, 41])('shows primary pool %s with the chosen percentage display', (primary) => {
    const p = cursorPools(primary, 90, 100)
    for (const display of ['used', 'remaining'] as const) {
      const shown = display === 'used' ? primary : 100 - primary
      const segment = renderToStaticMarkup(
        <ProviderSegment p={p} compact={false} mode="compact" display={display} />
      )
      expect(segment).toContain(`>${shown}% Cursor Models<`)
      const row = renderToStaticMarkup(
        <UsageRow
          p={p}
          mode="compact"
          display={display}
          state={{ kind: 'usage', statusLabel: null }}
          showSignInAction={false}
          now={0}
        />
      )
      expect(row).toContain('data-usage-window="Cursor Models"')
      expect(row).toContain(`${shown}%`)
      expect(row.match(/data-usage-window=/g)).toHaveLength(1)
    }
  })

  it.each(['Other Models', 'On-demand'] as const)(
    'keeps exhausted %s urgent in overflow and collapse decisions',
    (bucket) => {
      const p = bucket === 'Other Models' ? cursorPools(7, 100) : cursorPools(0, 0, 100)
      expect(getUsageTone(p)).toBe('urgent')
      expect(getTightestUsageSection(p)?.label).toBe(bucket)
      expect(getUsageHeadlineSection(p)?.label).toBe('Cursor Models')
      const overflow = renderToStaticMarkup(
        <UsageOverflowChip hidden={[p]} providerCount={1} display="used" />
      )
      expect(overflow).toContain('data-tone="urgent"')
      // The "+N" title is read on its own, so it keeps the sentence label.
      expect(overflow).toMatch(/title="[^"]*% used"/)
      expect(
        pickCollapsedUsageChips(
          [
            { provider: 'codex', width: 60, urgent: false, percentage: true },
            {
              provider: 'cursor',
              width: 60,
              urgent: getUsageTone(p) === 'urgent',
              percentage: true
            }
          ],
          20,
          10,
          0
        )
      ).toEqual(['codex'])
    }
  )

  it.each(['verbose', 'compact'] as const)(
    'keeps exhausted providers first in the %s roster',
    (mode) => {
      const cursor = cursorPools(7, 100)
      const codex: ProviderRateLimits = {
        provider: 'codex',
        session: windowAt(50),
        weekly: null,
        status: 'ok',
        updatedAt: 0,
        error: null
      }
      const markup = renderToStaticMarkup(
        <UsageRosterPanel
          providers={[codex, cursor]}
          display="used"
          statusBarUsageMode={mode}
          onStatusBarUsageModeChange={() => {}}
          isRefreshing={false}
          onRefresh={() => {}}
          onOpenProvider={() => {}}
          onSignIn={() => {}}
          canSignIn={() => false}
          onManageAccounts={() => {}}
          onUsageDetails={() => {}}
        />
      )
      expect(markup.indexOf('Cursor')).toBeLessThan(markup.indexOf('Codex'))
      if (mode === 'verbose') {
        expect(markup).toContain('data-usage-window="Other Models"')
        expect(markup).toContain('100%')
      }
    }
  )

  it('keeps detailed footer pools and falls back for legacy monthly-only usage', () => {
    const detailed = renderToStaticMarkup(
      <ProviderSegment p={cursorPools(7, 18)} compact={false} mode="verbose" display="used" />
    )
    expect(detailed).toContain('>Cursor Models 7%<')
    expect(detailed).toContain('>Other Models 18%<')
    const legacy: ProviderRateLimits = { ...cursorPools(0, 0), buckets: [], monthly: windowAt(44) }
    expect(getUsageHeadlineSection(legacy)?.window.usedPercent).toBe(44)
    const noPrimary: ProviderRateLimits = {
      ...legacy,
      buckets: [{ name: 'Other Models', ...windowAt(90) }]
    }
    expect(getUsageHeadlineSection(noPrimary)?.window.usedPercent).toBe(90)
  })

  it.each([
    'claude',
    'codex',
    'gemini',
    'grok',
    'zcode',
    'kimi',
    'antigravity',
    'minimax',
    'opencode-go'
  ] as const)('preserves %s selection', (provider) => {
    const p: ProviderRateLimits = { ...cursorPools(7, 90), provider }
    expect(getUsageHeadlineSection(p)).toEqual(getTightestUsageSection(p))
  })
})
