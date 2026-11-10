import { terminalAttachResult } from '../../../../../../shared/terminal/pty/lifecycle/terminal-attach-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: {
        id: string
        code: number
        preserveRendererBinding?: boolean
        incarnationId?: string
      }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onExit = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('drains an exited join with pre-request output and preserves its snapshot projection', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { ensurePtyDispatcher } = await import('../delivery/pty-dispatcher')
    const creator = {
      kind: 'registration-exited' as const,
      result: {
        id: 'exited-join',
        incarnationId: 'join-inc',
        snapshot: 'final snapshot',
        snapshotCols: 120,
        snapshotRows: 40,
        snapshotSeq: 7,
        snapshotKittyKeyboardFlags: 3
      }
    }
    const joined = terminalAttachResult(creator.result)
    ensurePtyDispatcher()
    onData!({ id: creator.result.id, data: 'final output' })
    onExit!({ id: creator.result.id, code: 23, incarnationId: creator.result.incarnationId })
    vi.mocked(window.api.pty.spawn).mockResolvedValue(joined)
    const onOutput = vi.fn()
    const onEnd = vi.fn()
    const transport = createIpcPtyTransport({})
    const result = await transport.connect({
      url: '',
      callbacks: { onData: onOutput, onExit: onEnd }
    })
    expect(onOutput).toHaveBeenCalledWith('final output')
    expect(onEnd).toHaveBeenCalledWith(23)
    expect(result).toEqual({ id: creator.result.id, exitedBeforeAttach: true })
    transport.detach?.()
    const snapshotView = createIpcPtyTransport({})
    expect(await snapshotView.connect({ url: '', callbacks: {} })).toMatchObject({
      id: creator.result.id,
      isReattach: true,
      snapshot: 'final snapshot',
      snapshotCols: 120,
      snapshotRows: 40,
      snapshotSeq: 7,
      snapshotKittyKeyboardFlags: 3
    })
    expect(creator.result).not.toHaveProperty('isReattach')
    snapshotView.detach?.()
  })

  it('stops gone-parking a session whose cold restore resolves after its transport was destroyed', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const gone = await import('../../../terminal/terminal-provider-gone-sessions')
    const { canWatcherCoverParkedTerminalTab } =
      await import('../../parking/output-watchers/terminal-parked-tab-watchers')
    const { captureParkedTerminalPaneCandidates } =
      await import('../../parking/output-watchers/terminal-parked-watcher-registry')
    const REVIVED_PTY_ID = 'repo::/wt@@revived'
    const { useAppStore } = await import('@/store/index')
    const { makeTab } = await import('@/store/terminals/terminal-tab.test-fixture')
    const tab = makeTab({ id: 'tab-revived', worktreeId: 'repo::/wt', ptyId: REVIVED_PTY_ID })
    useAppStore.setState({ tabsByWorktree: { 'repo::/wt': [tab] } })
    captureParkedTerminalPaneCandidates(tab.id, 'repo::/wt', [
      {
        ptyId: REVIVED_PTY_ID,
        paneId: 1,
        leafId: '11111111-1111-4111-8111-111111111111',
        drivesTabTitle: true
      }
    ])
    await gone.probeTerminalProviderGoneSessions([REVIVED_PTY_ID], async () => [REVIVED_PTY_ID])
    expect(canWatcherCoverParkedTerminalTab('repo::/wt', tab)).toBe(true)
    type SpawnResult = Awaited<ReturnType<typeof window.api.pty.spawn>>
    let resolveSpawn: (value: SpawnResult) => void = () => {}
    vi.mocked(window.api.pty.spawn).mockReturnValueOnce(
      new Promise<SpawnResult>((resolve) => {
        resolveSpawn = resolve
      })
    )

    const transport = createIpcPtyTransport({})
    const connecting = transport.connect({ url: '', sessionId: REVIVED_PTY_ID, callbacks: {} })
    await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalled())
    transport.destroy?.()
    resolveSpawn({ id: REVIVED_PTY_ID, coldRestore: { scrollback: '', cwd: '/repo' } })
    await connecting

    // Live again without an authoritative snapshot, so it must stay mounted where its own watchers run.
    expect(canWatcherCoverParkedTerminalTab('repo::/wt', tab)).toBe(false)
  })
})
