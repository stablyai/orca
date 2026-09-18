// @vitest-environment happy-dom

import { act } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  now: 1_000_000_000,
  useResetCountdownClock: vi.fn(() => 1_000_000_000)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
vi.mock('@/hooks/useResetCountdownClock', () => ({
  useResetCountdownClock: mocks.useResetCountdownClock
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children?: ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
    'aria-label'?: string
  }) => (
    <div {...props} onClick={() => onSelect?.({ preventDefault() {} })}>
      {children}
    </div>
  )
}))
vi.mock('@/components/settings/form-controls/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => null
}))

import { UsageRosterPanel } from './UsageRosterPanel'

function usageWindow(
  usedPercent: number,
  windowMinutes: number
): NonNullable<ProviderRateLimits['session']> {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

const activeCodex: ProviderRateLimits = {
  provider: 'codex',
  session: usageWindow(22, 300),
  weekly: usageWindow(11, 10_080),
  updatedAt: mocks.now,
  error: null,
  status: 'ok',
  planType: 'plus'
}

const inactiveCodexLimits: ProviderRateLimits = {
  provider: 'codex',
  session: usageWindow(81, 300),
  weekly: usageWindow(44, 10_080),
  updatedAt: mocks.now - 5 * 60_000,
  error: null,
  status: 'ok',
  planType: 'pro'
}

const inactiveCodexAccount: InactiveAccountUsage = {
  accountId: 'acct-work',
  rateLimits: inactiveCodexLimits,
  updatedAt: mocks.now - 5 * 60_000,
  isFetching: false
}

const panelCallbacks = {
  onStatusBarUsageModeChange: () => {},
  onRefresh: () => {},
  onOpenProvider: () => {},
  onSignIn: () => {},
  canSignIn: () => true,
  onManageAccounts: () => {},
  onUsageDetails: () => {}
}

describe('UsageRosterPanel inactive Codex accounts', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.useResetCountdownClock.mockClear()
    mocks.useResetCountdownClock.mockReturnValue(mocks.now)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderInactivePanel(
    overrides: {
      onOpenProvider?: (provider: ProviderRateLimits['provider']) => void
      onSignIn?: (provider: ProviderRateLimits['provider']) => void
      onRefresh?: () => void
      onFetchInactiveCodexAccounts?: () => void
      renderRow?: (p: ProviderRateLimits, row: ReactNode) => ReactNode
    } = {}
  ): void {
    act(() => {
      root.render(
        <UsageRosterPanel
          providers={[activeCodex]}
          display="used"
          statusBarUsageMode="verbose"
          isRefreshing={false}
          inactiveCodexAccounts={[inactiveCodexAccount]}
          codexAccountLabels={{ 'acct-work': 'work@example.com' }}
          {...panelCallbacks}
          {...overrides}
        />
      )
    })
  }

  it('renders the active Codex row and the inactive account with last-known percents', () => {
    renderInactivePanel()

    expect(container.querySelectorAll('[data-usage-provider="codex"]')).toHaveLength(2)
    expect(container.querySelector('[data-inactive-codex-account="acct-work"]')).not.toBeNull()
    expect(container.textContent).toContain('work@example.com')
    expect(container.textContent).toContain('22%')
    expect(container.textContent).toContain('11%')
    expect(container.textContent).toContain('81%')
    expect(container.textContent).toContain('44%')
    expect(container.textContent).toContain('Updated 5m ago')
  })

  it('does not switch accounts when the inactive Codex row is clicked', () => {
    const onOpenProvider = vi.fn()
    const onSignIn = vi.fn()
    const renderRow = vi.fn((_p: ProviderRateLimits, row: ReactNode) => row)
    renderInactivePanel({ onOpenProvider, onSignIn, renderRow })

    const inactiveRow = container.querySelector('[data-inactive-codex-account="acct-work"]')
    expect(inactiveRow).not.toBeNull()
    act(() => {
      inactiveRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenProvider).not.toHaveBeenCalled()
    expect(onSignIn).not.toHaveBeenCalled()
    expect(renderRow).toHaveBeenCalledTimes(1)
    expect(renderRow.mock.calls[0]?.[0]).toBe(activeCodex)
  })

  it('requests inactive Codex usage when the popover opens and when refresh is selected', () => {
    const onFetchInactiveCodexAccounts = vi.fn()
    const onRefresh = vi.fn()
    renderInactivePanel({ onFetchInactiveCodexAccounts, onRefresh })

    expect(onFetchInactiveCodexAccounts).toHaveBeenCalledTimes(1)

    const refresh = container.querySelector('[aria-label="Refresh rate limits"]')
    expect(refresh).not.toBeNull()
    act(() => {
      refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onFetchInactiveCodexAccounts).toHaveBeenCalledTimes(2)
  })
})
