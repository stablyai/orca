// @vitest-environment happy-dom
import type { PropsWithChildren, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const state = vi.hoisted(() => ({ narrow: false }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(values?.[key] ?? key))
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span /> }))
// These stand in for unrelated status controls and popup portals; usage rendering remains real.
vi.mock('./UpdateStatusSegment', () => ({ UpdateStatusSegment: () => null }))
vi.mock('./SkillUpdateStatusSegment', () => ({ SkillUpdateStatusSegment: () => null }))
vi.mock('./NativeChatResumeStatusSegment', () => ({ NativeChatResumeStatusSegment: () => null }))
vi.mock('./CaffeinateStatusSegment', () => ({ CaffeinateStatusSegment: () => null }))
vi.mock('./RemoteServerUpdateStatusSegment', () => ({
  RemoteServerUpdateStatusSegment: () => null
}))
vi.mock('./StatusBarVisibilityMenu', () => ({ StatusBarVisibilityMenu: () => null }))
vi.mock('./UsagePercentageDisplayChangeNotice', () => ({
  UsagePercentageDisplayChangeNotice: ({ children }: PropsWithChildren) => children
}))
vi.mock('./ClaudeSwitcherMenu', () => ({
  ClaudeSwitcherMenu: ({ triggerContent }: { triggerContent: ReactNode }) => triggerContent
}))
vi.mock('./CodexSwitcherMenu', () => ({
  CodexSwitcherMenu: ({ triggerContent }: { triggerContent: ReactNode }) => triggerContent
}))
vi.mock('./ProviderDetailsMenu', () => ({
  ProviderDetailsMenu: ({ triggerContent }: { triggerContent: ReactNode }) => triggerContent,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'close-menus'
}))
vi.mock('@/lib/desktop-window-chrome', () => ({ isPairedWebClientWindow: () => true }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => children,
  DropdownMenuTrigger: ({ children }: PropsWithChildren) => children,
  DropdownMenuContent: ({ children }: PropsWithChildren) => <section>{children}</section>,
  DropdownMenuItem: ({ children }: PropsWithChildren) => <div>{children}</div>
}))
vi.mock('./use-status-bar-controller', () => ({
  useStatusBarController: () => ({
    compact: state.narrow,
    iconOnly: state.narrow,
    rosterProviders: [limits(8)],
    usageEntries: ['personal@example.test', 'work@example.test'].map((label, index) => ({
      key: `local:claude:${index}`,
      provider: 'claude',
      accountId: String(index),
      label,
      runtimeTarget: { runtime: 'host', wslDistro: null },
      selected: index === 0,
      limits: limits(index === 0 ? 8 : 58),
      isFetching: false,
      updatedAt: 1_000
    })),
    hasVisibleUsageMeters: true,
    anyVisible: true,
    usageMenuOpen: true,
    usagePercentageDisplay: 'used',
    statusBarUsageMode: 'verbose',
    usageMenuFocusHandoff: {},
    handleRefresh: () => {},
    setStatusBarUsageMode: () => {},
    handleManageAccounts: () => {},
    handleUsageDetails: () => {},
    handleOpenProviderAccounts: () => {}
  })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { StatusBarSurface } from './StatusBarSurface'

function limits(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1_000,
    status: 'ok',
    error: null
  }
}

function renderSurface(narrow: boolean): HTMLDivElement {
  state.narrow = narrow
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <TooltipProvider>
      <StatusBarSurface floatingTerminalOpen={false} />
    </TooltipProvider>
  )
  return container
}

describe('all-account status bar', () => {
  it.each([false, true])(
    'shows both labeled Claude meters in footer and popup (narrow=%s)',
    (narrow) => {
      const container = renderSurface(narrow)
      const footer = container.querySelector('button[aria-label="Usage"]')
      const popup = container.querySelector('section')
      for (const surface of [footer, popup]) {
        expect(surface?.textContent).toContain('personal@example.test')
        expect(surface?.textContent).toContain('work@example.test')
        expect(surface?.textContent).toContain('8%')
        expect(surface?.textContent).toContain('58%')
      }
    }
  )
})
