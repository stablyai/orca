// @vitest-environment happy-dom
import { Profiler, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { StatusBarUsageArea } from './StatusBarUsageArea'
import type * as CodexRestartBadge from './accounts/CodexRestartBadge'

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { statusBarUsageFormat: undefined }) => unknown) =>
    selector({ statusBarUsageFormat: undefined })
}))
const restarts = vi.hoisted(() => ({ count: 0 }))
vi.mock('./accounts/CodexRestartBadge', async (load) => ({
  ...(await load<typeof CodexRestartBadge>()),
  useCodexStaleSessionCount: () => restarts.count
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

let areaWidth = 300
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
      ? areaWidth
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
  cleanup()
  restarts.count = 0
  areaWidth = 300
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observers.clear()
})

function controller(
  usageMenuOpen: boolean,
  rosterProviders: readonly ProviderRateLimits[] = PROVIDERS
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
    rosterProviders,
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
  render(
    <Profiler id="usage" onRender={flushResizeObservers}>
      <StatusBarUsageArea controller={controller(true)} />
    </Profiler>
  )
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'opencode-go submenu closed' }))
  })
  expect(screen.queryByRole('button', { name: 'opencode-go submenu open' })).not.toBeNull()
  // Six chips don't fit 300px even at one percentage each, so the last folds into "+1".
  expect(within(screen.getByRole('button', { name: 'Usage' })).getByText('+1')).toBeTruthy()
})

const claude = PROVIDERS[0]!
const codex = PROVIDERS[1]!

it("announces Codex restarts on the Usage button while the menu has Codex's row", () => {
  restarts.count = 2
  render(<StatusBarUsageArea controller={controller(true, [claude, codex])} />)
  expect(
    screen.getByRole('button', { name: 'Usage. 2 Codex sessions need a restart' })
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'codex submenu closed' })).toBeTruthy()
})

it("keeps announcing when Codex's chip folds into the overflow but its menu row remains", () => {
  restarts.count = 2
  areaWidth = 60
  render(<StatusBarUsageArea controller={controller(true, [claude, codex])} />)
  act(flushResizeObservers)
  const usage = screen.getByRole('button', { name: 'Usage. 2 Codex sessions need a restart' })
  // The overflow chip now stands in for Codex's chip.
  expect(within(usage).getByTitle(/^Also: .*Codex/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'codex submenu closed' })).toBeTruthy()
})

it('does not announce Codex restarts when the Codex status item is hidden from the menu', () => {
  restarts.count = 2
  render(<StatusBarUsageArea controller={controller(true, [claude])} />)
  expect(screen.getByRole('button', { name: 'Usage' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'codex submenu closed' })).toBeNull()
})

it('does not announce Codex restarts when the Codex row is a not-set-up placeholder', () => {
  restarts.count = 2
  const placeholder: ProviderRateLimits = {
    ...codex,
    usageMetadata: {
      ownerNotSetUp: {
        kind: 'not-configured',
        ownerLabel: 'Remote host',
        signInSavedHereOnly: false
      }
    }
  }
  render(<StatusBarUsageArea controller={controller(true, [claude, placeholder])} />)
  expect(screen.getByRole('button', { name: 'Usage' })).toBeTruthy()
})
