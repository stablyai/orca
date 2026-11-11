import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PtyConnectResult, PtyTransport } from '../../pty-transport/pty-transport-types'
import { reattachRestartPredecessor } from './restart-refusal-reattach'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.state } }))

function fixture() {
  const owner = { ptyId: 'original', incarnationId: 'original-incarnation' }
  const transport = {
    connect: vi
      .fn<
        (
          options: Parameters<PtyTransport['connect']>[0]
        ) => Promise<void | string | PtyConnectResult>
      >()
      .mockResolvedValue({
        id: 'original',
        incarnationId: 'original-incarnation',
        isReattach: true
      }),
    getPtyId: vi.fn(() => null)
  }
  const terminal = { options: { disableStdin: true } }
  const session = {
    deps: {
      tabId: 'tab',
      worktreeId: 'worktree',
      restartRecovery: owner,
      paneTransportsRef: { current: new Map([[1, transport]]) },
      consumeSuppressedPtyExit: vi.fn()
    },
    pane: { id: 1, leafId: 'leaf', terminal },
    transport,
    tabGeneration: 3,
    transportStreamGeneration: 0,
    pendingStartupCommand: { command: 'replacement-command' },
    paneStartup: { command: 'replacement-command' },
    captureTransportOutputCallbacks: vi.fn(() => {
      session.transportStreamGeneration += 1
      return { generation: session.transportStreamGeneration, callbacks: {}, launchContext: {} }
    }),
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    bindActivePanePty: vi.fn(() => true),
    handleReattachResult: vi.fn(async () => true),
    noteBoundProcessIncarnation: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    settlePaneAttachAttempt: vi.fn(),
    retainedTerminalHistory: { sessionId: 'original', painted: true },
    writeReplayData: vi.fn(),
    startFreshSpawn: vi.fn(),
    cacheKey: 'tab:leaf',
    cols: 80,
    rows: 24
  }
  mocks.state = {
    tabsByWorktree: { worktree: [{ id: 'tab', generation: 3 }] },
    terminalLayoutsByTabId: { tab: { ptyIdsByLeafId: { leaf: 'original' } } }
  }
  return { session: session as unknown as ConnectPanePtySession, transport, terminal }
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      pty: {
        declarePendingPaneSerializer: vi.fn(async () => 7),
        settlePaneSerializer: vi.fn(async () => {}),
        clearPendingPaneSerializer: vi.fn(async () => {})
      }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('retained local Restart predecessor', () => {
  it('restores input only after an exact host-confirmed live attach without replaying replacement startup', async () => {
    const { session, transport, terminal } = fixture()
    expect(await reattachRestartPredecessor(session)).toBe('original')
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'original',
        attachOnlyView: true,
        expectedAttachIncarnationId: 'original-incarnation'
      })
    )
    expect(transport.connect.mock.calls[0][0]).not.toHaveProperty('command')
    expect(session.pendingStartupCommand).toBeNull()
    expect(terminal.options.disableStdin).toBe(false)
    expect(session.writeReplayData).not.toHaveBeenCalled()
    expect(session.deps.restartRecovery).toBeUndefined()
    expect(session.startFreshSpawn).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { id: 'original', isReattach: true, incarnationId: 'later-incarnation' },
    { id: 'winner', isReattach: true, incarnationId: 'original-incarnation' }
  ])(
    'retains pixels and disables input when the original owner cannot be proven: %s',
    async (result) => {
      const { session, transport, terminal } = fixture()
      transport.connect.mockResolvedValueOnce(result)
      expect(await reattachRestartPredecessor(session)).toBeNull()
      expect(terminal.options.disableStdin).toBe(true)
      expect(session.bindActivePanePty).not.toHaveBeenCalled()
      expect(session.writeReplayData).not.toHaveBeenCalled()
      expect(session.startFreshSpawn).not.toHaveBeenCalled()
    }
  )

  it('does not attach without a captured incarnation or after the saved pane changes owner', async () => {
    const { session, transport } = fixture()
    session.deps.restartRecovery!.incarnationId = null
    expect(await reattachRestartPredecessor(session)).toBeNull()
    session.deps.restartRecovery!.incarnationId = 'original-incarnation'
    mocks.state.terminalLayoutsByTabId = { tab: { ptyIdsByLeafId: { leaf: 'winner' } } }
    expect(await reattachRestartPredecessor(session)).toBeNull()
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('settles exact live recovery while serializer bookkeeping remains pending', async () => {
    const { session, terminal } = fixture()
    vi.mocked(window.api.pty.declarePendingPaneSerializer).mockReturnValueOnce(
      new Promise(() => {})
    )
    expect(await reattachRestartPredecessor(session)).toBe('original')
    expect(terminal.options.disableStdin).toBe(false)
    expect(session.finishReattachLiveDataDeferral).toHaveBeenCalledWith(true, 1)
  })
})
