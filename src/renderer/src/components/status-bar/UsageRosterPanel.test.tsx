// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

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
    onSelect: _onSelect,
    ...props
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => <div {...props}>{children}</div>
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
