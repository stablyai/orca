// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'

const mocks = vi.hoisted(() => ({
  setActiveSpace: vi.fn(),
  openModal: vi.fn(),
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import SidebarSpaceSwitcher from './SidebarSpaceSwitcher'

function space(overrides: Partial<Space> & Pick<Space, 'id' | 'name' | 'emoji'>): Space {
  return { createdAt: 0, updatedAt: 0, ...overrides }
}

const DEFAULT_SPACE = space({ id: DEFAULT_SPACE_ID, name: 'Default', emoji: null })
const WORK_SPACE = space({ id: 'space-work', name: 'Work', emoji: '💼' })

function setSpaces(spaces: Space[], activeSpaceId = DEFAULT_SPACE_ID): void {
  mocks.state = {
    spaces,
    activeSpaceId,
    setActiveSpace: mocks.setActiveSpace,
    openModal: mocks.openModal
  } as unknown as Partial<AppState>
}

describe('SidebarSpaceSwitcher', () => {
  beforeEach(() => setSpaces([DEFAULT_SPACE]))

  afterEach(() => {
    cleanup()
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    vi.clearAllMocks()
  })

  it('renders the active Space as a dot and keeps creation reachable', async () => {
    const user = userEvent.setup()
    render(<SidebarSpaceSwitcher />)

    expect(screen.getByRole('group', { name: 'Spaces' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-current')).toBe(
      'true'
    )

    await user.click(screen.getByRole('button', { name: 'New Space' }))
    expect(mocks.openModal).toHaveBeenCalledWith('space-editor')
  })

  it('renders emoji Spaces and switches directly without a dropdown', async () => {
    setSpaces([DEFAULT_SPACE, WORK_SPACE])
    const user = userEvent.setup()
    render(<SidebarSpaceSwitcher />)

    expect(screen.getByRole('button', { name: 'Work' }).textContent).toContain('💼')
    await user.click(screen.getByRole('button', { name: 'Work' }))
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('space-work')
  })

  it('edits and deletes a custom Space but does not offer Default deletion', async () => {
    setSpaces([DEFAULT_SPACE, WORK_SPACE], 'space-work')
    const user = userEvent.setup()
    render(<SidebarSpaceSwitcher />)

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete Space' })
    expect(deleteButtons).toHaveLength(1)
    await user.click(screen.getAllByRole('button', { name: 'Edit Space' })[1])
    expect(mocks.openModal).toHaveBeenCalledWith('space-editor', { spaceId: 'space-work' })
    await user.click(deleteButtons[0])
    expect(mocks.openModal).toHaveBeenCalledWith('delete-space', { spaceId: 'space-work' })
  })

  // Why: happy-dom reports zero-sized rects, so the strip geometry has to be simulated.
  // The strip viewport is 0..100; the active indicator is 24 wide at `activeLeft`.
  function stubGeometry(activeLeft: number): () => void {
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute('role') === 'group') {
        return { left: 0, right: 100 } as DOMRect
      }
      if (this.getAttribute('aria-current') === 'true') {
        return { left: activeLeft, right: activeLeft + 24 } as DOMRect
      }
      return original.call(this)
    }
    return () => {
      Element.prototype.getBoundingClientRect = original
    }
  }

  const MANY_SPACES = Array.from({ length: 12 }, (_, i) =>
    space({ id: `space-${i}`, name: `S${i}`, emoji: null })
  )

  it('scrolls an off-screen active Space into view', () => {
    setSpaces(MANY_SPACES, 'space-11')
    const restore = stubGeometry(260)
    try {
      render(<SidebarSpaceSwitcher />)
      // 284 (right edge + 12 fade) - 100 (viewport width) = 196
      expect(screen.getByRole('group', { name: 'Spaces' }).scrollLeft).toBe(196)
    } finally {
      restore()
    }
  })

  it('leaves the strip alone when the active Space is already visible', () => {
    setSpaces(MANY_SPACES, 'space-1')
    const restore = stubGeometry(40)
    try {
      render(<SidebarSpaceSwitcher />)
      expect(screen.getByRole('group', { name: 'Spaces' }).scrollLeft).toBe(0)
    } finally {
      restore()
    }
  })

  it('keeps paired web clients on the all-project view', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    setSpaces([DEFAULT_SPACE, WORK_SPACE], 'space-work')

    const { container } = render(<SidebarSpaceSwitcher />)
    expect(container.childElementCount).toBe(0)
  })
})
