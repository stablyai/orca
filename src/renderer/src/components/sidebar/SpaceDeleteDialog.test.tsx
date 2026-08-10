// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'

const mocks = vi.hoisted(() => ({
  closeModal: vi.fn(),
  deleteSpace: vi.fn(async () => true),
  toastError: vi.fn(),
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import SpaceDeleteDialog from './SpaceDeleteDialog'

function setModal(spaceId: string): void {
  mocks.state = {
    activeModal: 'delete-space',
    modalData: { spaceId },
    closeModal: mocks.closeModal,
    spaces: [
      {
        id: DEFAULT_SPACE_ID,
        name: 'Default',
        emoji: null,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'space-work',
        name: 'Work',
        emoji: '💼',
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'space-personal',
        name: 'Personal',
        emoji: '🏠',
        createdAt: 0,
        updatedAt: 0
      }
    ],
    repos: [
      { id: 'repo-1', spaceId: 'space-work' },
      { id: 'repo-2', spaceId: null }
    ],
    deleteSpace: mocks.deleteSpace
  } as unknown as Partial<AppState>
}

describe('SpaceDeleteDialog', () => {
  beforeEach(() => {
    setModal('space-work')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('refuses to render for the Default Space', () => {
    setModal(DEFAULT_SPACE_ID)

    const { container } = render(<SpaceDeleteDialog />)

    expect(container.firstChild).toBeNull()
  })

  it('names both Spaces, counts reassigned projects, and deletes on confirm', async () => {
    const spaces = mocks.state.spaces as Space[]
    mocks.state = { ...mocks.state, spaces: [{ ...spaces[0]!, name: 'Personal' }, spaces[1]!] }
    const user = userEvent.setup()
    render(<SpaceDeleteDialog />)

    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByText(/1 project moves to Personal/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Delete Space' }))

    await waitFor(() => {
      expect(mocks.deleteSpace).toHaveBeenCalledWith('space-work')
    })
    expect(mocks.closeModal).toHaveBeenCalled()
  })
})
