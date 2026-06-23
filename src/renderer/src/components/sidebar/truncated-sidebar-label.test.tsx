// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSidebarLabelTruncated, TruncatedSidebarLabel } from './truncated-sidebar-label'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className} data-tooltip-content="">
      {children}
    </div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('isSidebarLabelTruncated', () => {
  it('returns false when the label fits', () => {
    expect(isSidebarLabelTruncated({ clientWidth: 120, scrollWidth: 120 })).toBe(false)
    expect(isSidebarLabelTruncated({ clientWidth: 120, scrollWidth: 119 })).toBe(false)
  })

  it('returns true when the label overflows', () => {
    expect(isSidebarLabelTruncated({ clientWidth: 120, scrollWidth: 121 })).toBe(true)
  })
})

describe('TruncatedSidebarLabel', () => {
  let container: HTMLDivElement
  let root: Root
  let originalClientWidth: PropertyDescriptor | undefined
  let originalScrollWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')

    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 120
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        return this.textContent?.includes('really-long-branch-name') ? 180 : 80
      }
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()

    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }

    if (originalScrollWidth) {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
    } else {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    }
  })

  it('remeasures when the branch text changes without a resize event', async () => {
    await act(async () => {
      root.render(<TruncatedSidebarLabel text="feature/short" />)
    })

    expect(container.querySelector('[data-tooltip-content]')).toBeNull()

    await act(async () => {
      root.render(<TruncatedSidebarLabel text="feature/really-long-branch-name" />)
    })

    const longTooltip = container.querySelector('[data-tooltip-content]')
    expect(longTooltip?.textContent).toBe('feature/really-long-branch-name')
    expect(longTooltip?.className).toContain('max-w-80')
    expect(longTooltip?.className).toContain('break-all')

    await act(async () => {
      root.render(<TruncatedSidebarLabel text="fix/short" />)
    })

    expect(container.querySelector('[data-tooltip-content]')).toBeNull()
  })

  it('keeps the nested tooltip disabled when a parent hover owns the full identity', async () => {
    await act(async () => {
      root.render(
        <TruncatedSidebarLabel text="feature/really-long-branch-name" tooltipEnabled={false} />
      )
    })

    expect(container.textContent).toContain('feature/really-long-branch-name')
    expect(container.querySelector('[data-tooltip-content]')).toBeNull()
  })
})
