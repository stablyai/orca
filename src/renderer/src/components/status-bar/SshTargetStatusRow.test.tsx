// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshTargetStatusRow } from './SshTargetStatusRow'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => undefined })}
    >
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-sub">{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-sub-content">{children}</div>
  ),
  DropdownMenuSubTrigger: ({
    children,
    hideChevron
  }: {
    children: ReactNode
    hideChevron?: boolean
  }) => (
    <div data-slot="dropdown-menu-sub-trigger" data-hide-chevron={hideChevron ? 'true' : 'false'}>
      {children}
    </div>
  )
}))

const recordFeatureInteraction = vi.fn()
vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: { recordFeatureInteraction: typeof recordFeatureInteraction }) => unknown
  ) => selector({ recordFeatureInteraction })
}))

afterEach(() => {
  cleanup()
  recordFeatureInteraction.mockReset()
})

describe('SshTargetStatusRow', () => {
  it('keeps clean rows free of a submenu trigger', () => {
    const { container } = render(
      <SshTargetStatusRow
        targetId="target-1"
        label="Dev Box"
        status="connected"
        syncStatus={{ phase: 'synced' }}
      />
    )

    expect(container.querySelector('[data-slot="dropdown-menu-sub-trigger"]')).toBeNull()
  })

  it('ignores out-of-range sync timestamps without crashing the menu', () => {
    expect(() =>
      render(
        <SshTargetStatusRow
          targetId="target-1"
          label="Dev Box"
          status="connected"
          syncStatus={{ phase: 'synced', lastSyncedAt: Number.MAX_VALUE }}
        />
      )
    ).not.toThrow()
  })

  it('renders a sync problem as a submenu with the full status message', () => {
    const message = `Workspace changed on another device. ${'Please retry after reviewing the layout. '.repeat(8)}`
    const { container } = render(
      <SshTargetStatusRow
        targetId="target-1"
        label="Dev Box"
        status="connected"
        syncStatus={{
          phase: 'conflict',
          direction: 'push',
          revision: 42,
          updatedAt: Date.now() - 60_000,
          lastSyncedAt: Date.now() - 360_000,
          message
        }}
      />
    )

    const trigger = container.querySelector('[data-slot="dropdown-menu-sub-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('data-hide-chevron')).toBe('true')
    const submenu = container.querySelector('[data-slot="dropdown-menu-sub-content"]')
    expect(submenu?.textContent).toContain('workspace layout changed on another device')
    expect(submenu?.textContent).toContain(message)
    expect(submenu?.textContent).toContain('Push')
    expect(submenu?.textContent).toContain('42')
    expect(submenu?.textContent).toContain('Last sync attempt')
  })

  it('keeps the disconnect action invokable from a problem row', async () => {
    const disconnect = vi.fn(async () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { disconnect } }
    })
    render(
      <SshTargetStatusRow
        targetId="target-1"
        label="Dev Box"
        status="connected"
        syncStatus={{ phase: 'error', message: 'Remote workspace sync unavailable' }}
      />
    )

    fireEvent.click(
      document.querySelector('[role="button"][aria-label="Disconnect"]') as HTMLElement
    )

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith({ targetId: 'target-1' }))
  })

  it('keeps the disconnect action keyboard accessible from a problem row', async () => {
    const disconnect = vi.fn(async () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { disconnect } }
    })
    render(
      <SshTargetStatusRow
        targetId="target-1"
        label="Dev Box"
        status="connected"
        syncStatus={{ phase: 'error', message: 'Remote workspace sync unavailable' }}
      />
    )

    fireEvent.keyDown(
      document.querySelector('[role="button"][aria-label="Disconnect"]') as HTMLElement,
      { key: 'Enter' }
    )

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith({ targetId: 'target-1' }))
  })
})
