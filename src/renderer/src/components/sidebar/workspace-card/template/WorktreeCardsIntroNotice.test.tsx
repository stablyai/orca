// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import './worktree-card-style-telemetry'
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

/** Main stores New, then the renderer publishes it. */
function savingNew(wait: Promise<void> = Promise.resolve()): Save {
  return vi.fn<Save>(async () => {
    await wait
    useAppStore.setState({ settings: newSettings })
  })
}

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
