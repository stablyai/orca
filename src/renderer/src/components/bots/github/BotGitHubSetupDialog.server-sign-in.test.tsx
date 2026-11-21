// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { stopAwaitingGitHub } from '@/lib/bot-github-state'
import { openGitHubInstall, resetGitHubInstallForTests } from '@/lib/bot-github-install-record'
import { useAppStore } from '@/store'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../../shared/bot-types'

// The first Connect click for a bot whose host answers signed out: a server's goes to Sign in on the
// server, never this computer's own sign-in, which would leave the server signed out.
type Mocks = {
  hostLabel: string | null
  startHostSignIn: ReturnType<typeof vi.fn>
  listed: Bot[]
  githubState: ReturnType<typeof vi.fn>
}
const mocks = vi.hoisted((): Mocks => ({
  hostLabel: null,
  startHostSignIn: vi.fn(),
  listed: [],
  githubState: vi.fn()
}))
vi.mock('@/lib/bot-catalog', () => ({
  updateBot: vi.fn(),
  readBots: () => mocks.listed,
  useBots: () => mocks.listed,
  // Sign in on <server> opens the bot's Connectors tab first, which keeps the wait in view.
  openBotHome: () => true
}))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => mocks.hostLabel }))
// Each host answers GitHub's state for itself: signed out here.
vi.mock('@/lib/bot-connector-host-calls', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  botGitHubCalls: () => ({
    state: mocks.githubState,
    users: vi.fn(),
    unlink: vi.fn(),
    setDefaultBot: vi.fn()
  })
}))
// The server is verified and takes an approve-in-browser sign-in.
vi.mock('@/lib/bot-host-status', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  useBotHostVerified: () => true,
  useBotHostHas: () => true
}))
vi.mock('@/lib/bot-host-orca-account', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  startBotHostSignIn: mocks.startHostSignIn,
  useBotHostOrcaAccount: () => ({ state: 'signed-out', storage: { kind: 'os-keychain' } }),
  useBotHostOrcaAccountSettled: () => true
}))

import { GitHubInstallMount } from './GitHubInstallMount'
// Loaded up front, as the mount loads it lazily.
import './GitHubInstallSurface'

const SERVER: ExecutionHostId = 'runtime:box1'
const own: Bot = {
  id: 'bot-1',
  name: 'Ranger',
  hostId: 'local',
  folder: 'ranger',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const onServer = stampBotHost(SERVER, own)

const connect = vi.fn()
const confirm = vi.fn()
const initialStore = useAppStore.getState()

beforeEach(() => {
  connect.mockReset()
  mocks.startHostSignIn.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({ connectCurrentOrcaProfile: connect })
  mocks.githubState.mockReset().mockResolvedValue({ ok: false, error: 'signed_out' })
})

afterEach(() => {
  cleanup()
  resetGitHubInstallForTests()
  stopAwaitingGitHub('local')
  stopAwaitingGitHub(SERVER)
  useAppStore.setState(initialStore, true)
})

function connectGitHub(bot: Bot): void {
  mocks.listed = [bot]
  act(() => openGitHubInstall(bot))
  render(
    <TooltipProvider>
      <ConfirmationDialogContext.Provider value={confirm}>
        <GitHubInstallMount />
      </ConfirmationDialogContext.Provider>
    </TooltipProvider>
  )
}

describe('Connect GitHub for a host that answers signed out', () => {
  it("asks for a server's own sign-in, never this computer's", async () => {
    mocks.hostLabel = 'box1'
    connectGitHub(onServer)

    const signIn = await screen.findByRole('button', { name: 'Sign in on box1' }, { timeout: 5000 })
    expect(screen.getByText('Sign box1 in to Orca Cloud to connect GitHub.')).toBeTruthy()
    expect(
      screen.queryByText('GitHub connects through Orca Cloud. Sign in to Orca to continue.')
    ).toBeNull()
    fireEvent.click(signIn)
    expect(mocks.startHostSignIn).toHaveBeenCalledWith(
      SERVER,
      expect.objectContaining({ id: 'bot-1', hostId: SERVER })
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it("asks for this computer's sign-in for its own bot", async () => {
    mocks.hostLabel = null
    connectGitHub(own)

    expect(
      await screen.findByText(
        'GitHub connects through Orca Cloud. Sign in to Orca to continue.',
        undefined,
        { timeout: 5000 }
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Sign in on / })).toBeNull()
  })
})
