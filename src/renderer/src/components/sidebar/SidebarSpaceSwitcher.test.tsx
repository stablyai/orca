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

// Radix pointer events do not open under happy-dom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-space-menu="">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange
  }: {
    children: ReactNode
    value: string
    onValueChange: (next: string) => void
  }) => (
    <div
      data-radio-group=""
      data-value={value}
      onClick={(event) => {
        const spaceId = (event.target as HTMLElement).closest<HTMLElement>('[data-space-id]')
          ?.dataset.spaceId
        if (spaceId) {
          onValueChange(spaceId)
        }
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" data-space-id={value}>
      {children}
    </button>
  ),
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

import SidebarSpaceSwitcher from './SidebarSpaceSwitcher'

function space(overrides: Partial<Space> & Pick<Space, 'id' | 'name' | 'emoji'>): Space {
  return {
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
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

function renderSwitcher(): void {
  render(<SidebarSpaceSwitcher fallbackTitle="Projects" sectionTitle="projects" />)
}

function trigger(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-sidebar-space-switcher]')!
}

function menuRows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-space-menu] button[data-space-id]')
  )
}

describe('SidebarSpaceSwitcher', () => {
  beforeEach(() => {
    setSpaces([DEFAULT_SPACE])
  })

  afterEach(() => {
    cleanup()
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    vi.clearAllMocks()
  })

  it('preserves the plain sidebar while keeping first-Space actions reachable', async () => {
    const user = userEvent.setup()
    renderSwitcher()

    expect(trigger().textContent).toBe('Projects')
    expect(trigger().dataset.spaceId).toBeUndefined()
    expect(menuRows()).toHaveLength(0)
    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-space-menu] button:not([data-space-id])')
    )
    expect(actions.map((action) => action.textContent)).toEqual(['Edit Space', 'New Space'])

    await user.click(actions[1] as HTMLButtonElement)
    expect(mocks.openModal).toHaveBeenCalledWith('space-editor')
  })

  it('keeps a customized Default visible without custom Spaces', () => {
    setSpaces([{ ...DEFAULT_SPACE, name: 'Personal', emoji: '🏠' }])

    renderSwitcher()

    expect(trigger().textContent).toContain('🏠Personal')
    expect(trigger().getAttribute('aria-label')).toBe('Spaces: Personal')
  })

  it('keeps paired web clients on the plain all-project view', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    setSpaces([DEFAULT_SPACE, WORK_SPACE], 'space-work')

    renderSwitcher()

    expect(screen.getByText('Projects')).toBeTruthy()
    expect(document.querySelector('[data-sidebar-space-switcher]')).toBeNull()
    expect(document.querySelector('[data-space-menu]')).toBeNull()
  })

  it('renders, switches, edits, and deletes a custom Space without offering Default deletion', async () => {
    setSpaces([DEFAULT_SPACE, WORK_SPACE], 'space-work')
    const user = userEvent.setup()

    renderSwitcher()

    expect(trigger().textContent).toContain('💼Work')
    expect(trigger().dataset.spaceId).toBe('space-work')
    expect(menuRows().map((row) => row.dataset.spaceId)).toEqual([DEFAULT_SPACE_ID, 'space-work'])
    await user.click(menuRows()[0] as HTMLButtonElement)
    expect(mocks.setActiveSpace).toHaveBeenCalledWith(DEFAULT_SPACE_ID)
    await user.click(screen.getByText('Edit Space'))
    expect(mocks.openModal).toHaveBeenCalledWith('space-editor', { spaceId: 'space-work' })
    await user.click(screen.getByText('Delete Space'))
    expect(mocks.openModal).toHaveBeenCalledWith('delete-space', { spaceId: 'space-work' })

    cleanup()
    setSpaces([DEFAULT_SPACE, WORK_SPACE], DEFAULT_SPACE_ID)
    renderSwitcher()

    expect(screen.queryByText('Delete Space')).toBeNull()
    expect(screen.getByText('Edit Space')).toBeTruthy()
  })
})
