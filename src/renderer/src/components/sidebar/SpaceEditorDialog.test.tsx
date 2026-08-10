// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'

const mocks = vi.hoisted(() => ({
  closeModal: vi.fn(),
  createSpace: vi.fn(async () => true),
  updateSpace: vi.fn(async () => true),
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

// Why: the real grid picker renders thousands of lazy emoji nodes; the click contract is what matters.
vi.mock('emoji-picker-react', () => ({
  default: ({ onEmojiClick }: { onEmojiClick: (data: { emoji: string }) => void }) => (
    <div className="epr-body" data-testid="emoji-scroll-region">
      <button type="button" onClick={() => onEmojiClick({ emoji: '🚀' })}>
        pick-rocket
      </button>
    </div>
  ),
  EmojiStyle: { NATIVE: 'native' },
  Theme: { DARK: 'dark', LIGHT: 'light' }
}))

import SpaceEditorDialog from './SpaceEditorDialog'

const WORK_SPACE: Space = {
  id: 'space-work',
  name: 'Work',
  emoji: '💼',
  createdAt: 0,
  updatedAt: 0
}

function setModal(spaceId?: string): void {
  mocks.state = {
    activeModal: 'space-editor',
    modalData: spaceId ? { spaceId } : {},
    closeModal: mocks.closeModal,
    spaces: [
      { id: DEFAULT_SPACE_ID, name: 'Default', emoji: null, createdAt: 0, updatedAt: 0 },
      WORK_SPACE
    ],
    createSpace: mocks.createSpace,
    updateSpace: mocks.updateSpace
  } as unknown as Partial<AppState>
}

describe('SpaceEditorDialog', () => {
  beforeEach(() => {
    setModal()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a Space from the name and selected emoji', async () => {
    const user = userEvent.setup()
    render(<SpaceEditorDialog />)

    await user.type(screen.getByLabelText('Name'), 'Research')
    await user.click(screen.getByLabelText('Choose Space emoji'))
    await user.click(await screen.findByText('pick-rocket'))
    await user.click(screen.getByRole('button', { name: 'Create Space' }))

    await waitFor(() => {
      expect(mocks.createSpace).toHaveBeenCalledWith({ name: 'Research', emoji: '🚀' })
    })
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('seeds an edited Space and can clear its emoji while renaming', async () => {
    setModal('space-work')
    const user = userEvent.setup()
    render(<SpaceEditorDialog />)

    const nameInput = screen.getByLabelText<HTMLInputElement>('Name')
    expect(nameInput.value).toBe('Work')

    await user.clear(nameInput)
    await user.type(nameInput, 'Work v2')
    await user.click(screen.getByLabelText('Choose Space emoji'))
    await user.click(await screen.findByText('Remove emoji'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mocks.updateSpace).toHaveBeenCalledWith('space-work', {
        name: 'Work v2',
        emoji: null
      })
    })
  })

  // Why: the picker is portaled out of this dialog, so its own wheel handler has
  // to drive the grid past the dialog's scroll lock.
  it('scrolls the emoji grid with wheel input inside the dialog', async () => {
    const user = userEvent.setup()
    render(<SpaceEditorDialog />)

    await user.click(screen.getByLabelText('Choose Space emoji'))
    const scrollRegion = await screen.findByTestId('emoji-scroll-region')
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 }
    })

    fireEvent.wheel(scrollRegion, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 120 })

    await waitFor(() => expect(scrollRegion.scrollTop).toBe(120))
  })

  // Why: StrictMode reuses the mounted ref across its remount, which once left the
  // dialog permanently disabled after a save (input, Cancel and close all stuck).
  it('closes after saving when mounted under StrictMode', async () => {
    setModal('space-work')
    const user = userEvent.setup()
    render(
      <StrictMode>
        <SpaceEditorDialog />
      </StrictMode>
    )

    await user.type(screen.getByLabelText('Name'), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.closeModal).toHaveBeenCalled())
  })

  it('stays open and allows retrying when save fails', async () => {
    mocks.createSpace.mockResolvedValueOnce(false)
    const user = userEvent.setup()
    render(<SpaceEditorDialog />)

    await user.type(screen.getByLabelText('Name'), 'Research')
    await user.click(screen.getByRole('button', { name: 'Create Space' }))

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't save the Space")
    expect(mocks.closeModal).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create Space' }).disabled).toBe(
      false
    )
  })
})
