// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { trackWorktreeCardsIntroAction } from './worktree-card-style-telemetry'
import { WorktreeCardsIntroNotice } from './WorktreeCardsIntroNotice'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('./worktree-card-style-telemetry', () => ({
  trackWorktreeCardsIntroAction: vi.fn(),
  trackWorktreeCardStyleChanged: vi.fn()
}))

type Save = AppState['updateSettingsOrThrow']

const initialState = useAppStore.getState()
const classicSettings: GlobalSettings = {
  ...getDefaultSettings('/home/test'),
  experimentalNewWorktreeCardStyle: false
}
const newSettings: GlobalSettings = { ...classicSettings, experimentalNewWorktreeCardStyle: true }

function Note(): React.JSX.Element {
  return (
    <>
      <div data-worktree-sidebar tabIndex={0} />
      <WorktreeCardsIntroNotice />
    </>
  )
}

// The note stays hidden until its first floating position resolves.
const settle = (): Promise<void> => act(async () => {})

async function renderNote(save: Save) {
  useAppStore.setState({
    settings: classicSettings,
    worktreeCardsIntroNoticeSeen: true,
    worktreeCardsIntroChoice: 'new',
    worktreeCardsIntroKeptHintOpen: false,
    updateSettingsOrThrow: save
  })
  const view = render(<Note />)
  await settle()
  return view
}

function gate(): { wait: Promise<void>; open: () => void; fail: () => void } {
  let open = (): void => {}
  let fail = (): void => {}
  const wait = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = () => reject(new Error('save failed'))
  })
  return { wait, open, fail }
}

/** Main stores New, then the renderer publishes it. */
function savingNew(wait: Promise<void> = Promise.resolve()): Save {
  return vi.fn<Save>(async () => {
    await wait
    useAppStore.setState({ settings: newSettings })
  })
}

const keptEvents = (): unknown[][] =>
  vi.mocked(trackWorktreeCardsIntroAction).mock.calls.filter(([action]) => action === 'kept')

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('focuses the checked tile once placed when nothing else had focus', async () => {
  await renderNote(savingNew())

  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'New' }))
})

it('closes on Escape from a footer button, stays on Classic unsaved and keeps focus off body', async () => {
  const save = savingNew()
  await renderNote(save)
  const notNow = screen.getAllByRole('button', { name: 'Not now' }).at(-1)!
  act(() => notNow.focus())

  const escape = fireEvent.keyDown(notNow, { key: 'Escape' })

  expect(escape).toBe(false)
  expect(useAppStore.getState().worktreeCardsIntroChoice).toBeNull()
  expect(screen.queryByRole('radiogroup', { name: 'Card style' })).not.toBeInTheDocument()
  expect(save).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(document.querySelector('[data-worktree-sidebar]'))
})

it('leaves Escape pressed outside the note to the page', async () => {
  await renderNote(savingNew())
  const outside = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!

  const escape = fireEvent.keyDown(outside, { key: 'Escape' })

  expect(escape).toBe(true)
  expect(useAppStore.getState().worktreeCardsIntroChoice).toBe('new')
})

it('closes without saving when Classic is picked and confirmed with Use classic', async () => {
  const save = savingNew()
  await renderNote(save)

  fireEvent.click(screen.getByRole('radio', { name: 'Classic' }))
  expect(useAppStore.getState().worktreeCardsIntroChoice).toBe('classic')
  fireEvent.click(screen.getByRole('button', { name: 'Use classic' }))

  expect(useAppStore.getState().worktreeCardsIntroChoice).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

it('saves the new cards on Keep new, closes and points to where to switch back', async () => {
  const save = savingNew()
  await renderNote(save)

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Keep new' }))
  })

  expect(save).toHaveBeenCalledWith({ experimentalNewWorktreeCardStyle: true })
  expect(useAppStore.getState().settings?.experimentalNewWorktreeCardStyle).toBe(true)
  expect(screen.queryByRole('radiogroup', { name: 'Card style' })).not.toBeInTheDocument()
  expect(useAppStore.getState().worktreeCardsIntroKeptHintOpen).toBe(true)
})

it('hands focus to the card list when the opener can no longer take it', async () => {
  const opener = render(<button type="button">Opener</button>).getByRole('button')
  act(() => opener.focus())
  await renderNote(savingNew())
  const newTile = screen.getByRole('radio', { name: 'New' })
  act(() => newTile.focus())
  opener.setAttribute('disabled', '')

  fireEvent.keyDown(newTile, { key: 'Escape' })

  expect(document.activeElement).toBe(document.querySelector('[data-worktree-sidebar]'))
})

it('stays open on New and unlocks when saving Keep new fails', async () => {
  const pending = gate()
  await renderNote(savingNew(pending.wait))

  fireEvent.click(screen.getByRole('button', { name: 'Keep new' }))
  await act(async () => pending.fail())

  expect(toast.error).toHaveBeenCalled()
  expect(screen.getByRole('radio', { name: 'New' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('radio', { name: 'Classic' })).toBeEnabled()
  expect(useAppStore.getState().worktreeCardsIntroKeptHintOpen).toBe(false)
  expect(keptEvents()).toEqual([])
  fireEvent.click(screen.getAllByRole('button', { name: 'Not now' }).at(-1)!)
  expect(useAppStore.getState().worktreeCardsIntroChoice).toBeNull()
})
