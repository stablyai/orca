// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/popover', () => ({
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { renderResourceUsageStatusTrigger } from './resource-usage-status-trigger'

describe('resource usage status trigger', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderTrigger(overrides: { iconOnly: boolean; totalCpu: number }): string {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        renderResourceUsageStatusTrigger({
          daemonUnreachable: false,
          resourceManagerAriaLabel: 'Resource Manager',
          spaceScanReady: false,
          commitToneClass: null,
          memBadgeLabel: '512 MB',
          triggerSessionCount: 2,
          orphanCount: 0,
          resourceManagerTooltipLines: [],
          ...overrides
        })
      )
    })
    return container.textContent ?? ''
  }

  it('shows memory, total CPU, and session count in the badge', () => {
    expect(renderTrigger({ iconOnly: false, totalCpu: 12.34 })).toBe('512 MB·12.3%·2')
  })

  it('keeps the badge compact when the status bar is icon-only', () => {
    expect(renderTrigger({ iconOnly: true, totalCpu: 12.34 })).toBe('2')
  })
})
