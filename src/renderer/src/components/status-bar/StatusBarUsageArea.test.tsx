// @vitest-environment happy-dom
import { Profiler, type ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { StatusBarUsageArea } from './StatusBarUsageArea'

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { statusBarUsageFormat: undefined }) => unknown) =>
    selector({ statusBarUsageFormat: undefined })
}))
vi.mock('./usage/StatusBarUsageChangeNotices', () => ({
  StatusBarUsageChangeNotices: ({ children }: { children: ReactNode }) => children
}))
vi.mock('./usage/UsageRosterPanel', () => ({
  UsageRosterPanel: ({
    providers,
    renderRow
  }: {
    providers: ProviderRateLimits[]
    renderRow: (p: ProviderRateLimits, row: ReactNode) => ReactNode
  }) => providers.map((p) => <div key={p.provider}>{renderRow(p, p.provider)}</div>)
}))
type SubmenuProps = {
  provider?: ProviderRateLimits
  claude?: ProviderRateLimits
  codex?: ProviderRateLimits
  antigravity?: ProviderRateLimits
}
/** Stands in for each provider's drill-in submenu; opening one is a plain local state change. */
const submenus = vi.hoisted(async () => {
  const { createElement, useState } = await import('react')
  function Submenu(props: SubmenuProps): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const p = props.provider ?? props.claude ?? props.codex ?? props.antigravity
    return createElement(
      'button',
      { type: 'button', onClick: () => setOpen((value) => !value) },
      `${p?.provider} submenu ${open ? 'open' : 'closed'}`
    )
  }
  return { Submenu }
})
vi.mock('./usage/ProviderDetailsMenu', async () => ({
  ProviderDetailsMenu: (await submenus).Submenu
}))
vi.mock('./accounts/ClaudeSwitcherMenu', async () => ({
  ClaudeSwitcherMenu: (await submenus).Submenu
}))
vi.mock('./accounts/CodexSwitcherMenu', async () => ({
  CodexSwitcherMenu: (await submenus).Submenu
}))
vi.mock('./usage/AntigravityUsageMenu', async () => ({
  AntigravityUsageMenu: (await submenus).Submenu
}))

// A fixed clock: the reset countdown reads Date.now(), pinned to this in beforeEach.
const NOW = Date.UTC(2026, 10, 20, 12)
const PROVIDERS = (['claude', 'codex', 'opencode-go', 'kimi', 'grok', 'cursor'] as const).map(
  (provider, index): ProviderRateLimits => ({
    provider,
    status: 'ok',
    error: null,
    updatedAt: NOW,
    session: null,
    weekly: {
      usedPercent: 20 + index,
      windowMinutes: 10080,
      resetsAt: NOW + 86_400_000,
      resetDescription: null
    }
  })
)

const AREA_WIDTH = 300
// Measuring chips' widths per level; the shown row's width is never read, so it isn't stubbed.
const CHIP_WIDTHS = [110, 48, 45]

const observers = new Set<ResizeObserverCallback>()
function flushResizeObservers(): void {
  for (const callback of observers) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook ignores its observer argument.
    callback([], {} as ResizeObserver)
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.add(callback)
      }
      observe(): void {}
      disconnect(): void {
        observers.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const level = Number(this.dataset.measureLevel)
    const width = this.hasAttribute('data-usage-area')
      ? AREA_WIDTH
      : this.hasAttribute('data-measure-chip')
        ? (CHIP_WIDTHS[level] ?? 0)
        : this.hasAttribute('data-measure-unit')
          ? 30
          : this.hasAttribute('data-measure-more')
            ? 26
            : 0
    return new DOMRect(0, 0, width, 16)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observers.clear()
})

function controller(
  usageMenuOpen: boolean
): Parameters<typeof StatusBarUsageArea>[0]['controller'] {
  const noop = () => {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the area reads only the fields set here.
  return {
    antigravityAccounts: [],
    anyFetching: false,
    anyVisible: false,
    canSignInFromUsageRow: false,
    handleManageAccounts: noop,
    handleOpenProviderAccounts: noop,
    handleRefresh: noop,
    handleUsageDetails: noop,
    handleUsageMenuOpenChange: noop,
    hasVisibleUsageMeters: true,
    isEmptyUsageState: false,
    isRefreshing: false,
    ownerUsage: { owner: { target: { kind: 'local' }, wslHostDistro: null } },
    remoteOwner: null,
    rosterProviders: PROVIDERS,
    setStatusBarUsageMode: noop,
    showEmptyUsageCta: false,
    statusBarUsageMode: 'verbose',
    usageMenuFocusHandoff: { onPointerDownOutside: noop, onCloseAutoFocus: noop },
    usageMenuOpen,
    usagePercentageDisplay: 'used'
  } as unknown as Parameters<typeof StatusBarUsageArea>[0]['controller']
}

// Guards React #185: opening a submenu (the OpenCode 2 one in the report) commits while the bar
// re-measures; a layout chosen from its own rendered widths kept re-rendering until React threw.
it('settles while a usage submenu opens and every commit re-measures', () => {
  let commits = 0
  render(
    <Profiler
      id="usage"
      onRender={() => {
        commits += 1
        // Like a live layout, every commit reports a resize to each observer.
        flushResizeObservers()
      }}
    >
      <StatusBarUsageArea controller={controller(true)} />
    </Profiler>
  )
  const settled = commits
  for (let i = 0; i < 3; i += 1) {
    act(() => {
      fireEvent.click(screen.getByText(/^opencode-go submenu/))
    })
  }
  expect(screen.getByText('opencode-go submenu open')).toBeTruthy()
  // One commit per click: measuring never schedules another render.
  expect(commits - settled).toBe(3)
  // Six chips don't fit 300px even at one percentage each, so the last folds into "+1".
  expect(within(screen.getByRole('button', { name: 'Usage' })).getByText('+1')).toBeTruthy()
})
