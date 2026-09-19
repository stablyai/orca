// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  now: 1_000_000_000,
  useResetCountdownClock: vi.fn(() => 1_000_000_000)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-catalog', () => ({
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
  }: React.PropsWithChildren<{
    onSelect?: (event: { preventDefault: () => void }) => void
  }>) => (
    <div {...props} onClick={() => onSelect?.({ preventDefault() {} })}>
      {children}
    </div>
  )
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageRosterPanel, UsageRow } from './UsageRosterPanel'

const signedOutCodex: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  updatedAt: 0,
  error: 'ChatGPT authentication required to read rate limits',
  status: 'error'
}

describe('UsageRow', () => {
  beforeEach(() => {
    mocks.useResetCountdownClock.mockClear()
  })

  it('renders sign-in as row copy instead of nesting an interactive button', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={signedOutCodex}
        display="used"
        state={{ kind: 'sign-in', statusLabel: 'not signed in' }}
        showSignInAction
        now={mocks.now}
      />
    )

    expect(markup).toContain('not signed in')
    expect(markup).toContain('Sign in')
    expect(markup).not.toContain('<button')
  })

  it('keeps the bar fill consistent with the remaining percentage label', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="remaining"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('75%')
    expect(markup).toContain('width:75%')
    expect(markup).not.toContain('width:25%')
  })

  it('uses one shared clock for live reset labels across the roster', () => {
    const sessionReset = mocks.now + 2 * 60_000
    const weeklyReset = mocks.now + 7 * 24 * 60 * 60_000
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <UsageRosterPanel
          providers={[
            {
              ...signedOutCodex,
              session: {
                usedPercent: 25,
                windowMinutes: 300,
                resetsAt: sessionReset,
                resetDescription: null
              },
              weekly: {
                usedPercent: 10,
                windowMinutes: 10_080,
                resetsAt: weeklyReset,
                resetDescription: null
              },
              status: 'ok',
              error: null
            }
          ]}
          display="used"
          statusBarUsageMode="verbose"
          onStatusBarUsageModeChange={() => {}}
          isRefreshing={false}
          onRefresh={() => {}}
          onOpenProvider={() => {}}
          onSignIn={() => {}}
          canSignIn={() => true}
          onManageAccounts={() => {}}
          onUsageDetails={() => {}}
        />
      </TooltipProvider>
    )

    expect(mocks.useResetCountdownClock).toHaveBeenCalledOnce()
    expect(mocks.useResetCountdownClock).toHaveBeenCalledWith([sessionReset, weeklyReset])
    expect(markup).toContain('Resets in 2m')
    expect(markup).toContain('5h')
    expect(markup).toContain('25%')
    expect(markup).toContain('wk')
    expect(markup).toContain('10%')
  })

  it('renders the tightest window inline in compact mode', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: mocks.now + 2 * 60_000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: mocks.now + 7 * 24 * 60 * 60_000,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="used"
        mode="compact"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('data-usage-mode="compact"')
    expect(markup.match(/data-usage-window=/g)).toHaveLength(1)
    expect(markup).not.toContain('data-usage-bar')
    expect(markup).toContain('60%')
    expect(markup).not.toContain('25%')
    expect(markup).not.toContain('Resets in')
  })

  it('uses the same compact selection for Claude subscription windows', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          provider: 'claude',
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          fableWeekly: {
            usedPercent: 75,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          updatedAt: 0,
          status: 'ok',
          error: null
        }}
        display="used"
        mode="compact"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup.match(/data-usage-window=/g)).toHaveLength(1)
    expect(markup).not.toContain('data-usage-bar')
    expect(markup).toContain('Fable')
    expect(markup).toContain('75%')
    expect(markup).not.toContain('25%')
    expect(markup).not.toContain('60%')
  })

  it('renders every window below the header in verbose mode', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={{
          ...signedOutCodex,
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          },
          status: 'ok',
          error: null
        }}
        display="used"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={mocks.now}
      />
    )

    expect(markup).toContain('data-usage-mode="verbose"')
    expect(markup.match(/data-usage-window=/g)).toHaveLength(2)
    expect(markup.match(/data-usage-bar/g)).toHaveLength(2)
    expect(markup).toContain('25%')
    expect(markup).toContain('60%')
  })
})

describe('UsageRosterPanel density picker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.useResetCountdownClock.mockClear()
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

  function renderPanel(
    statusBarUsageMode: 'verbose' | 'compact',
    onStatusBarUsageModeChange: (mode: 'verbose' | 'compact') => void
  ): void {
    act(() => {
      root.render(
        <TooltipProvider>
          <UsageRosterPanel
            providers={[]}
            display="used"
            statusBarUsageMode={statusBarUsageMode}
            onStatusBarUsageModeChange={onStatusBarUsageModeChange}
            isRefreshing={false}
            onRefresh={() => {}}
            onOpenProvider={() => {}}
            onSignIn={() => {}}
            canSignIn={() => true}
            onManageAccounts={() => {}}
            onUsageDetails={() => {}}
          />
        </TooltipProvider>
      )
    })
  }

  function segmentButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === label
    )
    if (!button) {
      throw new Error(`missing "${label}" segment`)
    }
    return button as HTMLButtonElement
  }

  it('offers named Detailed/Compact segments and marks the active one', () => {
    renderPanel('compact', () => {})

    expect(container.textContent).toContain('Detailed')
    expect(container.textContent).toContain('Compact')
    expect(segmentButton('Compact').getAttribute('aria-checked')).toBe('true')
    expect(segmentButton('Detailed').getAttribute('aria-checked')).toBe('false')
  })

  it('switches mode when a segment is chosen', () => {
    const onStatusBarUsageModeChange = vi.fn()
    renderPanel('compact', onStatusBarUsageModeChange)

    act(() => {
      segmentButton('Detailed').click()
    })
    expect(onStatusBarUsageModeChange).toHaveBeenLastCalledWith('verbose')

    act(() => {
      segmentButton('Compact').click()
    })
    expect(onStatusBarUsageModeChange).toHaveBeenLastCalledWith('compact')
  })
})

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
      renderRow?: (p: ProviderRateLimits, row: React.ReactNode) => React.ReactNode
    } = {}
  ): void {
    act(() => {
      root.render(
        <TooltipProvider>
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
        </TooltipProvider>
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
    const renderRow = vi.fn((_p: ProviderRateLimits, row: React.ReactNode) => row)
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

describe('UsageRosterPanel live Updated labels', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(mocks.now)
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
    mocks.useResetCountdownClock.mockReturnValue(mocks.now)
    vi.useRealTimers()
  })

  it('refreshes Updated labels every minute when reset timestamps are null', () => {
    const updatedAt = mocks.now - 30_000
    act(() => {
      root.render(
        <TooltipProvider>
          <UsageRosterPanel
            providers={[activeCodex]}
            display="used"
            statusBarUsageMode="verbose"
            isRefreshing={false}
            inactiveCodexAccounts={[
              {
                ...inactiveCodexAccount,
                updatedAt,
                rateLimits: { ...inactiveCodexLimits, updatedAt }
              }
            ]}
            codexAccountLabels={{ 'acct-work': 'work@example.com' }}
            {...panelCallbacks}
          />
        </TooltipProvider>
      )
    })

    expect(container.textContent).toContain('Updated just now')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(container.textContent).toContain('Updated 1m ago')
    expect(container.textContent).not.toContain('Updated just now')
  })
})
