import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: { id: string; code: number; preserveRendererBinding?: boolean }) => void)
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

  it("spawns a launch pane this window made only once the host has taken it, and never once it's gone", async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { holdAgentLaunchPaneSpawn, releaseAgentLaunchPaneSpawn } =
      await import('@/lib/agent-launch-pane-spawn-hold')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const pane = { worktreeId: 'wt', tabId: 'tab-held', leafId: 'leaf-held' }

    holdAgentLaunchPaneSpawn(pane.tabId, pane.leafId)
    const transport = createIpcPtyTransport(pane)
    const connecting = transport.connect({ url: '', callbacks: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawn).not.toHaveBeenCalled()

    releaseAgentLaunchPaneSpawn(pane.tabId, pane.leafId)
    await connecting
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-held' }))
    transport.disconnect()

    spawn.mockClear()
    const release = holdAgentLaunchPaneSpawn(pane.tabId, pane.leafId)
    const closed = createIpcPtyTransport(pane)
    const abandoned = closed.connect({ url: '', callbacks: {} })
    closed.destroy?.()
    release()
    await expect(abandoned).resolves.toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
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

  it('sends the missing-cwd fallback flag only for local IPC spawns', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
  })

  it('omits the missing-cwd fallback flag when the IPC transport is SSH-tagged', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ connectionId: 'ssh-1', cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
  })

  it('omits the missing-cwd fallback flag for session reattach spawns', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {}, sessionId: 'session-1' })

    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
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

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })

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
})
