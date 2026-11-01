import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { ConnectCallbacks } from './pty-connection-test-pane-fixtures'
import { terminalAttachResult } from '../../../../shared/terminal-attach-result'
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

  it('exposes explicit local or direct SSH ownership without inferring it from the workspace', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    for (const connectionId of [undefined, 'qa']) {
      const transport = createIpcPtyTransport({ connectionId })
      expect(transport.getExecutionHostId?.()).toBe(connectionId ? 'ssh:qa' : 'local')
      expect(transport.getRuntimeEnvironmentId?.()).toBeNull()
      transport.destroy?.()
    }
  })

  it.each([0, 1, 420])(
    'preserves snapshot sequence and keyboard proof %s across IPC reattach',
    async (seq) => {
      const { createIpcPtyTransport } = await import('./pty-transport')
      vi.mocked(window.api.pty.spawn).mockResolvedValue({
        id: 'existing',
        isReattach: true,
        snapshot: 'ready',
        snapshotSeq: seq,
        snapshotKittyKeyboardFlags: 0
      })
      const transport = createIpcPtyTransport({})
      const result = await transport.connect({ url: '', sessionId: 'existing', callbacks: {} })
      expect(result).toMatchObject({ snapshotSeq: seq, snapshotKittyKeyboardFlags: 0 })
      transport.detach?.()
    }
  )

  it('drains an exited join with pre-request output and preserves its snapshot projection', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
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

  it('leaves title tracking to the PTY data stream (no OpenCode IPC channel)', async () => {
    // Why: the OpenCode status IPC channel is gone (now the agent-hooks server), so the transport has no per-agent status callback.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    expect(onData).not.toBeNull()
    expect(onExit).not.toBeNull()
    transport.disconnect()
  })

  // A pane drag waits out a spawn whose result would bind the leaf to its old tab.
  it('reports a connect as pending only until its PTY id arrives', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    let resolveSpawn!: (value: { id: string }) => void
    vi.mocked(window.api.pty.spawn).mockReturnValue(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )
    const transport = createIpcPtyTransport({})
    expect(transport.isConnectPending?.()).toBe(false)

    const connecting = transport.connect({ url: '', callbacks: {} })
    expect(transport.isConnectPending?.()).toBe(true)
    resolveSpawn({ id: 'pty-late' })
    await connecting

    expect(transport.getPtyId()).toBe('pty-late')
    expect(transport.isConnectPending?.()).toBe(false)
    transport.disconnect()
  })

  it('does not create a PTY when the pane generation is stale', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({})

    await expect(
      transport.connect({ url: '', shouldContinue: () => false, callbacks: {} })
    ).resolves.toBeUndefined()

    expect(spawn).not.toHaveBeenCalled()
  })

  it("carries an AI button's launch in its pane's spawn, and says whether the agent started", async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { awaitAgentLaunchPaneStart } = await import('@/lib/agent-launch-pane-start')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const agentLaunch = { launch: { agent: 'claude' } }
    const pane = { worktreeId: 'wt', tabId: 'tab-launch', leafId: 'leaf-launch' }

    const started = awaitAgentLaunchPaneStart(pane.tabId, pane.leafId)
    spawn.mockResolvedValueOnce({ id: 'pty-launch' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport forwards the request untouched; main validates it.
    await createIpcPtyTransport({ ...pane, agentLaunch } as never).connect({
      url: '',
      callbacks: {}
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-launch', agentLaunch })
    )
    await expect(started).resolves.toBe('pty-launch')

    spawn.mockRejectedValueOnce(new Error('agent_launch_pane_refused'))
    const refused = awaitAgentLaunchPaneStart(pane.tabId, pane.leafId)
    await createIpcPtyTransport(pane).connect({ url: '', callbacks: { onError: vi.fn() } })
    await expect(refused).resolves.toBeNull()
  })

  it('keeps the recovery hint and raw diagnostic from a wrapped spawn error', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'pty:spawn': Error: Close unused terminals, then try again.\nnode-pty: open_slave failed: EMFILE (errno 24)"
      )
    )
    const onError = vi.fn()

    await createIpcPtyTransport({}).connect({ url: '', callbacks: { onError } })

    expect(onError).toHaveBeenCalledWith(
      'Close unused terminals, then try again.\nnode-pty: open_slave failed: EMFILE (errno 24)'
    )
  })

  it('threads provider command ownership through the spawn IPC', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({
      command: 'printf ready',
      commandDelivery: 'provider'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(window.api.pty.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'printf ready',
        commandDelivery: 'provider'
      })
    )
    transport.disconnect()
  })

  it('forwards requested environment deletions to the PTY spawn', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'] })
    )
  })

  it('forwards automatic resume provenance to the PTY spawn', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const resumeProviderSession = {
      key: 'session_id' as const,
      id: 'session-a',
      transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-a.jsonl'
    }
    const transport = createIpcPtyTransport({ resumeProviderSession })

    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ resumeProviderSession }))
  })

  it('exposes the connection identity captured at transport creation', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')

    expect(createIpcPtyTransport({}).getConnectionId?.()).toBeNull()
    expect(createIpcPtyTransport({ connectionId: 'ssh-1' }).getConnectionId?.()).toBe('ssh-1')
  })

  it('exposes local session metadata only for local IPC PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const localTransport = createIpcPtyTransport({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo',
          distro: 'Ubuntu-24.04',
          reason: 'project-override',
          cacheKey: 'repo:wsl'
        }
      }
    })
    const sshTransport = createIpcPtyTransport({
      connectionId: 'ssh-1',
      cwd: 'C:\\Users\\alice\\repo',
      shellOverride: 'cmd.exe'
    })

    expect(localTransport.getLocalSessionMetadata?.()).toEqual({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe'
    })
    expect(sshTransport.getLocalSessionMetadata?.()).toBeNull()
  })

  it('keeps captured Windows and WSL metadata when existing PTYs reattach', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const currentWslForWindowsPty = createIpcPtyTransport({
      cwd: 'C:\\repo',
      shellOverride: 'pwsh.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo',
          distro: 'Ubuntu-24.04',
          reason: 'project-override',
          cacheKey: 'repo:wsl'
        }
      }
    })
    const currentWindowsForWslPty = createIpcPtyTransport({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo',
          reason: 'project-override',
          cacheKey: 'repo:windows'
        }
      }
    })

    currentWslForWindowsPty.attach({ existingPtyId: 'windows-pty', callbacks: {} })
    currentWindowsForWslPty.attach({ existingPtyId: 'wsl-pty', callbacks: {} })

    expect(currentWslForWindowsPty.getLocalSessionMetadata?.()).toEqual({
      cwd: 'C:\\repo',
      shellOverride: 'pwsh.exe'
    })
    expect(currentWindowsForWslPty.getLocalSessionMetadata?.()).toEqual({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe'
    })
  })

  it('sends placement on a fresh spawn but not on a session reattach', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const placement = {
      kind: 'split',
      parentLeafId: '11111111-1111-4111-8111-111111111111',
      direction: 'horizontal'
    } as const

    const fresh = createIpcPtyTransport({ placement })
    await fresh.connect({ url: '', callbacks: {} })
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ placement }))
    fresh.disconnect()

    const reattach = createIpcPtyTransport({ placement })
    await reattach.connect({ url: '', callbacks: {}, sessionId: 'session-1' })
    expect(spawn).toHaveBeenLastCalledWith(expect.not.objectContaining({ placement }))
    reattach.disconnect()
  })

  it('returns startup cwd fallback metadata to the connection layer', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({
      id: 'pty-1',
      startupCwdFallback: { kind: 'worktree', cwd: '/repo/app' }
    })

    const transport = createIpcPtyTransport({})

    await expect(transport.connect({ url: '', callbacks: {} })).resolves.toEqual({
      id: 'pty-1',
      startupCwdFallback: { kind: 'worktree', cwd: '/repo/app' }
    })
    transport.disconnect()
  })

  it('forwards the declined-resume signal on fresh and cold-restore spawns alike', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({ id: 'pty-1', agentResumeUnavailable: true })

    const freshTransport = createIpcPtyTransport({})
    await expect(freshTransport.connect({ url: '', callbacks: {} })).resolves.toEqual({
      id: 'pty-1',
      agentResumeUnavailable: true
    })
    freshTransport.disconnect()

    spawn.mockResolvedValueOnce({
      id: 'pty-2',
      coldRestore: { scrollback: 'recovered', cwd: '/repo/app' },
      agentResumeUnavailable: true
    })
    const coldTransport = createIpcPtyTransport({})
    await expect(coldTransport.connect({ url: '', callbacks: {} })).resolves.toEqual(
      expect.objectContaining({ id: 'pty-2', agentResumeUnavailable: true })
    )
    coldTransport.disconnect()
  })

  it('passes startup commands through PTY spawn instead of writing them after connect', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({ id: 'pty-1' })
    const writeMock = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: writeMock,
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })

    await transport.connect({
      url: '',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    expect(spawnMock).toHaveBeenCalledWith({
      cols: 120,
      rows: 40,
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })
    expect(writeMock).not.toHaveBeenCalled()
  })
  it('paints an old image and delayed live bytes once without claiming their newer frontier', async () => {
    const { provenSpawnResponse } = await import('../../../../shared/terminal-spawn-response')
    const { bindPtyConnectionTestMocks } = await import('./pty-connection-mocks.spec')
    const { createInitialStoreState } = await import('./pty-connection-test-store-fixtures')
    const { buildPaneConnectionDeps } = await import('./pty-connection-test-deps')
    const { createMockTransport, createPaneContainer, LEAF_1 } =
      await import('./pty-connection-test-pane-fixtures')
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { SearchAddon } = await import('@xterm/addon-search')
    const { SerializeAddon } = await import('@xterm/addon-serialize')
    const { PaneManager } = await import('@/lib/pane-manager/pane-manager')
    const { isTerminalLeafId } = await import('../../../../shared/stable-pane-id')
    const { installTerminalTestGlobals, restoreTerminalTestGlobals } =
      await import('./pty-connection-test-environment')
    const { flushAsyncTicks } = await import('./pty-connection-test-async')
    let state = createInitialStoreState(() => state)
    const transports: ReturnType<typeof createMockTransport>[] = []
    bindPtyConnectionTestMocks({
      getState: () => state,
      getTransportQueue: () => transports,
      getTransportOptions: () => [],
      getStoreSubscribers: () => [],
      setStoreSubscribers: () => {}
    })
    await installTerminalTestGlobals()
    try {
      const { connectPanePty } = await import('./pty-connection')
      for (const proof of ['interleaved', 'covered', 'no-flags'] as const) {
        state = createInitialStoreState(() => state)
        const result = provenSpawnResponse(
          {
            id: 'tab-pty',
            isReattach: true,
            snapshot: 'OLD',
            providerSequence: { value: 900, generation: 'continued' as const },
            ...(proof !== 'no-flags' ? { snapshotKittyKeyboardFlags: 0 } : {})
          },
          proof === 'covered' ? 900 : undefined
        )
        const transport = createMockTransport('tab-pty')
        let callbacks: ConnectCallbacks | undefined
        transport.connect.mockImplementation(async (options: { callbacks?: ConnectCallbacks }) => {
          callbacks = options.callbacks
          return result
        })
        transports.push(transport)
        const leafId: string = LEAF_1
        if (!isTerminalLeafId(leafId)) {
          throw new Error('Expected a terminal leaf UUID')
        }
        const terminal = new Terminal({
          cols: 120,
          rows: 40,
          scrollback: 5_000,
          allowProposedApi: true,
          theme: { foreground: '#eeeeee', background: '#111111' },
          vtExtensions: { kittyKeyboard: true }
        })
        const writes: string[] = []
        const parseCallbacks: (() => void)[] = []
        vi.spyOn(terminal, 'write').mockImplementation((data, callback) => {
          writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          if (callback) {
            parseCallbacks.push(callback)
          }
        })
        const container = createPaneContainer()
        Object.defineProperty(container, 'querySelectorAll', { value: () => [] })
        const pane: ManagedPane = {
          id: 1,
          leafId,
          stablePaneId: leafId,
          terminal,
          container,
          linkTooltip: createPaneContainer(),
          fitAddon: new FitAddon(),
          searchAddon: new SearchAddon(),
          serializeAddon: new SerializeAddon()
        }
        vi.spyOn(pane.fitAddon, 'fit').mockImplementation(() => {})
        vi.spyOn(pane.fitAddon, 'proposeDimensions').mockReturnValue({ cols: 120, rows: 40 })
        const manager = new PaneManager(container, { linkOpenHint: () => '' })
        vi.spyOn(manager, 'getPanes').mockReturnValue([pane])
        vi.spyOn(manager, 'getLeafId').mockReturnValue(leafId)
        vi.spyOn(manager, 'getNumericIdForLeaf').mockReturnValue(1)
        const fixtureDeps = buildPaneConnectionDeps(() => state, {
          isVisibleRef: { current: true },
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
        })
        const deps: PtyConnectionDeps = {
          ...fixtureDeps,
          paneTransportsRef: { current: new Map() },
          paneMode2031Ref: { current: new Map() },
          paneLastThemeModeRef: { current: new Map() },
          replayingPanesRef: { current: new Map() },
          syncPanePtyLayoutBinding: (paneId, ptyId) => {
            if (ptyId !== null) {
              fixtureDeps.syncPanePtyLayoutBinding(paneId, ptyId)
            }
          }
        }
        const binding = connectPanePty(pane, manager, deps)
        try {
          await flushAsyncTicks(20)
          for (let step = 0; step < 40; step += 1) {
            parseCallbacks.shift()?.()
            await flushAsyncTicks(2)
          }
          // The stream reaches main at 903 before the control reply; its delivery to this view is delayed until after OLD paints.
          expect(writes.join('')).toContain('OLD')
          callbacks?.onData?.('NEW', { seq: 903, rawLength: 3 })
          for (let step = 0; step < 40; step += 1) {
            parseCallbacks.shift()?.()
            await flushAsyncTicks(2)
          }
          expect(writes.join('').match(/OLD/g), proof).toHaveLength(1)
          expect(writes.join('').match(/NEW/g), proof).toHaveLength(1)
          expect(result.snapshotSeq).toBe(proof === 'covered' ? 900 : undefined)
        } finally {
          binding.dispose()
          manager.destroy()
          pane.fitAddon.dispose()
          pane.searchAddon.dispose()
          pane.serializeAddon.dispose()
          terminal.dispose()
        }
      }
    } finally {
      await restoreTerminalTestGlobals()
    }
  })
})
