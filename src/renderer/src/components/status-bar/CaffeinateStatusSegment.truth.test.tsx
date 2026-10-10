// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'

const storeMocks = vi.hoisted(() => ({
  settings: {
    computerAwakeMode: 'on',
    keepComputerAwakeWhileAgentsRun: true
  },
  updateSettings: vi.fn()
}))

const awakeMocks = vi.hoisted(() => ({
  status: { mode: 'on', active: true },
  unsubscribe: vi.fn(),
  getStatus: vi.fn(),
  onChangedHandler: undefined as ((status: { mode: string; active: boolean }) => void) | undefined
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: storeMocks.settings, updateSettings: storeMocks.updateSettings })
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => false
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => (
    <div role="menuitemradio" aria-checked="false">
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />
}))

beforeEach(() => {
  storeMocks.settings = {
    computerAwakeMode: 'on',
    keepComputerAwakeWhileAgentsRun: true
  }
  awakeMocks.status = { mode: 'on', active: true }
  awakeMocks.unsubscribe.mockClear()
  awakeMocks.onChangedHandler = undefined
  // getStatus never resolves within these tests unless a test awaits it explicitly - this lets
  // us assert the pre-first-status render without racing a real promise resolution.
  awakeMocks.getStatus.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentAwake: {
        getStatus: awakeMocks.getStatus,
        onChanged: vi.fn().mockImplementation((handler) => {
          awakeMocks.onChangedHandler = handler
          return awakeMocks.unsubscribe
        })
      }
    }
  })
})

afterEach(cleanup)

describe('CaffeinateStatusSegment status truth', () => {
  it('does not flash Inactive before the first status arrives when configured mode is on', async () => {
    // getStatus deliberately never resolves in this test - only the pre-status render is asserted.
    awakeMocks.getStatus.mockReturnValue(new Promise(() => {}))

    render(<CaffeinateStatusSegment iconOnly={false} />)

    const trigger = await screen.findByRole('button')
    expect(trigger.getAttribute('aria-label')).toContain('Active')
    expect(trigger.getAttribute('aria-label')).not.toContain('Inactive')
  })

  it('reports Inactive once the service disagrees with an "on" configured setting', async () => {
    awakeMocks.getStatus.mockResolvedValue({ mode: 'off', active: false })

    render(<CaffeinateStatusSegment iconOnly={false} />)

    const trigger = await screen.findByRole('button')
    await vi.waitFor(() => {
      expect(trigger.getAttribute('aria-label')).toContain('Inactive')
    })
    expect(trigger.getAttribute('aria-label')).not.toContain('· Active')
  })

  it('reports Inactive when a later onChanged push disagrees with the configured setting', async () => {
    awakeMocks.getStatus.mockResolvedValue({ mode: 'on', active: true })

    render(<CaffeinateStatusSegment iconOnly={false} />)

    const trigger = await screen.findByRole('button')
    await vi.waitFor(() => {
      expect(trigger.getAttribute('aria-label')).toContain('· Active')
    })

    awakeMocks.onChangedHandler?.({ mode: 'off', active: false })

    await vi.waitFor(() => {
      expect(trigger.getAttribute('aria-label')).toContain('Inactive')
    })
  })
})
