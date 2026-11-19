// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NO_APP = { status: 'ready', google: { client: null, accounts: [], bots: [] } }
const mocks = vi.hoisted(() => {
  const view: { current: object } = { current: {} }
  const bots: { current: object[] } = { current: [] }
  return {
    importGoogleApp: vi.fn(),
    pickClientFile: vi.fn(),
    startGoogleSetupInChat: vi.fn(),
    view,
    bots
  }
})
vi.mock('./google-connect-client', () => ({
  useGoogleHost: () => mocks.view.current,
  importGoogleApp: mocks.importGoogleApp,
  disconnectGoogle: vi.fn(),
  refreshGoogle: vi.fn(),
  shareGoogleApp: vi.fn()
}))
vi.mock('@/lib/bot-catalog', () => ({ useHostBots: () => mocks.bots.current }))
vi.mock('./setup-cards/google-setup-run-store', () => ({
  startGoogleSetupInChat: mocks.startGoogleSetupInChat
}))
vi.mock('../NewBotDialog', () => ({
  NewBotDialog: ({
    open,
    onCreated
  }: {
    open: boolean
    onCreated: (bot: typeof NEW_BOT) => void
  }) =>
    open ? (
      <button type="button" onClick={() => onCreated(NEW_BOT)}>
        Create bot
      </button>
    ) : null
}))

import { useAppStore } from '@/store'
import { GoogleAccountSettings } from './GoogleAccountSettings'

const NEW_BOT = { id: 'new', name: 'Nova', folderWorkspaceId: 'f-new', hostId: 'local' }
const IVY = { id: 'ivy', name: 'Ivy', folderWorkspaceId: 'f-ivy', hostId: 'local' }
const REX = { id: 'rex', name: 'Rex', folderWorkspaceId: 'f-rex', hostId: 'local' }

const TEAM_FILE = '{"installed":{"client_id":"1.apps.googleusercontent.com"}}'

beforeEach(() => {
  mocks.view.current = NO_APP
  mocks.importGoogleApp.mockReset().mockResolvedValue(undefined)
  mocks.pickClientFile.mockReset()
  mocks.startGoogleSetupInChat.mockReset().mockResolvedValue(undefined)
  mocks.bots.current = [IVY, REX]
  useAppStore.setState({ lastVisitedAtByWorktreeId: { 'folder:f-rex': 20, 'folder:f-ivy': 10 } })
  Object.assign(window, { api: { googleSetup: { pickClientFile: mocks.pickClientFile } } })
})
afterEach(cleanup)

function renderNoApp(): HTMLElement {
  render(<GoogleAccountSettings target={{ kind: 'local' }} />)
  const section = screen.getByText('About 10 minutes').closest('section')
  if (!section) {
    throw new Error('no section')
  }
  return section
}

describe('Google with no app on this computer', () => {
  it('sets Google up in the chat of the bot visited last, naming it', () => {
    renderNoApp()
    expect(screen.getByText('Opens Rex’s chat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Google' }))
    expect(mocks.startGoogleSetupInChat).toHaveBeenCalledWith(REX, 'settings')
  })

  it('with no bots, creates one and sets Google up in its chat', () => {
    mocks.bots.current = []
    renderNoApp()
    expect(screen.queryByRole('button', { name: 'Set up Google' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create a bot to set up Google' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))
    expect(mocks.startGoogleSetupInChat).toHaveBeenCalledWith(NEW_BOT, 'settings')
  })

  it('imports a team file picked through "Import file"', async () => {
    mocks.pickClientFile.mockResolvedValue({ ok: true, text: TEAM_FILE })
    renderNoApp()
    fireEvent.click(screen.getByRole('button', { name: 'Import file' }))
    await waitFor(() =>
      expect(mocks.importGoogleApp).toHaveBeenCalledWith({ kind: 'local' }, TEAM_FILE)
    )
  })

  it('imports a team file dropped anywhere on the section, highlighting while dragging', async () => {
    const section = renderNoApp()
    fireEvent.dragOver(section)
    expect(section.getAttribute('data-dragging')).toBe('true')
    const file = new File([TEAM_FILE], 'client_secret.json', { type: 'application/json' })
    await act(async () => {
      fireEvent.drop(section, { dataTransfer: { files: [file] } })
    })
    expect(section.getAttribute('data-dragging')).toBe('false')
    await waitFor(() =>
      expect(mocks.importGoogleApp).toHaveBeenCalledWith({ kind: 'local' }, TEAM_FILE)
    )
  })

  it('shows why a file was refused', async () => {
    mocks.pickClientFile.mockResolvedValue({ ok: false, message: 'This isn’t a Google app file.' })
    renderNoApp()
    fireEvent.click(screen.getByRole('button', { name: 'Import file' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This isn’t a Google app file.')
    expect(mocks.importGoogleApp).not.toHaveBeenCalled()
  })
})
