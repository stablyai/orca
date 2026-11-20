import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtyApi, createSshApi } from './host-capabilities/web-terminal-api'

const {
  callRuntimeResult,
  callEnvironmentEnvelope,
  isTauriNativeHost,
  requireActiveEnvironment,
  requireActiveEnvironmentOrNull,
  confirmRuntimeTerminalForegroundProcess
} = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(),
  callEnvironmentEnvelope: vi.fn(),
  isTauriNativeHost: vi.fn(() => false),
  requireActiveEnvironment: vi.fn(() => ({ id: 'env-1' })),
  requireActiveEnvironmentOrNull: vi.fn(() => ({ id: 'env-1' })),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult, callEnvironmentEnvelope }))
vi.mock('../tauri-native-host', () => ({ isTauriNativeHost }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment,
  requireActiveEnvironmentOrNull
}))
vi.mock('../../runtime/runtime-terminal-inspection', () => ({
  confirmRuntimeTerminalForegroundProcess
}))

describe('Tauri terminal and SSH preload APIs', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
    callEnvironmentEnvelope.mockReset()
    confirmRuntimeTerminalForegroundProcess.mockReset()
    isTauriNativeHost.mockReturnValue(false)
    requireActiveEnvironment.mockReturnValue({ id: 'env-1' })
    requireActiveEnvironmentOrNull.mockReturnValue({ id: 'env-1' })
  })

  const moveRequest = {
    worktreeId: 'worktree-1',
    sourceTabId: 'tab-source',
    targetTabId: 'tab-target',
    leafId: '11111111-1111-4111-8111-111111111111',
    ptyId: 'remote:env-1@@terminal-1'
  }

  it('keeps browser-only leaf moves on the existing fallback', async () => {
    await expect(createPtyApi().moveLeafToNewTab(moveRequest)).resolves.toEqual({
      status: 'not_held'
    })
    expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
  })

  it('commits Tauri leaf moves on the bound environment before returning', async () => {
    isTauriNativeHost.mockReturnValue(true)
    const result = { status: 'moved', ptyId: moveRequest.ptyId, tabId: 'tab-target' }
    callEnvironmentEnvelope.mockResolvedValue({ ok: true, result })
    await expect(createPtyApi().moveLeafToNewTab(moveRequest)).resolves.toEqual(result)
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith(
      'env-1',
      'terminal.moveLeafToNewTab',
      moveRequest,
      undefined,
      undefined
    )
  })

  it('refuses to mutate a terminal owned by another environment', async () => {
    isTauriNativeHost.mockReturnValue(true)
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })
    await expect(createPtyApi().moveLeafToNewTab(moveRequest)).resolves.toEqual({
      status: 'refused',
      reason: 'pty_mismatch'
    })
    expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
  })

  it('does not pretend an older host committed an unsupported move', async () => {
    isTauriNativeHost.mockReturnValue(true)
    callEnvironmentEnvelope.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'Unsupported leaf move' }
    })
    await expect(createPtyApi().moveLeafToNewTab(moveRequest)).rejects.toThrow(
      'Unsupported leaf move'
    )
  })

  it('routes process inspection to the runtime with the host handle', async () => {
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })
    callEnvironmentEnvelope.mockResolvedValue({
      ok: true,
      result: { process: { foregroundProcess: 'codex', hasChildProcesses: true } }
    })
    const api = createPtyApi()

    await expect(
      api.inspectProcess?.('remote:env-1@@terminal-7', {
        expectedIncarnationId: 'inc-1',
        scanChildProcesses: true,
        steadyState: true
      })
    ).resolves.toEqual({ foregroundProcess: 'codex', hasChildProcesses: true })
    await expect(api.hasChildProcesses?.('remote:env-1@@terminal-7')).resolves.toBe(true)
    await expect(api.getForegroundProcess?.('remote:env-1@@terminal-7')).resolves.toBe('codex')

    expect(callEnvironmentEnvelope.mock.calls).toEqual([
      [
        'env-1',
        'terminal.inspectProcess',
        {
          terminal: 'terminal-7',
          expectedIncarnationId: 'inc-1',
          scanChildProcesses: true
        }
      ],
      ['env-1', 'terminal.inspectProcess', { terminal: 'terminal-7' }],
      ['env-1', 'terminal.inspectProcess', { terminal: 'terminal-7' }]
    ])
  })

  it('maps runtime terminal inventory to the conservative PTY session contract', async () => {
    callEnvironmentEnvelope.mockResolvedValue({
      ok: true,
      result: {
        terminals: [
          {
            handle: 'terminal-1',
            ptyId: 'pty-1',
            worktreeId: 'worktree-1',
            worktreePath: 'C:/repo',
            title: 'Codex',
            agentIdentity: 'codex'
          },
          {
            handle: 'terminal-2',
            ptyId: null,
            worktreeId: 'worktree-1',
            worktreePath: 'C:/repo',
            title: null
          }
        ],
        totalCount: 2,
        truncated: false
      }
    })
    const api = createPtyApi()

    await expect(api.listSessions?.()).resolves.toEqual([
      {
        id: 'remote:env-1@@terminal-1',
        cwd: 'C:/repo',
        title: 'Codex',
        worktreeId: 'worktree-1',
        agentOwnership: 'present'
      }
    ])
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith('env-1', 'terminal.list', {})
  })

  it('returns unknown when runtime liveness cannot be verified', async () => {
    callEnvironmentEnvelope.mockRejectedValue(new Error('runtime disconnected'))
    await expect(createPtyApi().hasPty?.('remote:env-1@@terminal-1')).resolves.toBeNull()
  })

  it('uses the runtime-owned authoritative buffer for remount snapshots', async () => {
    const snapshot = {
      data: '\u001b[2Jscreen',
      cols: 120,
      rows: 40,
      seq: 17,
      source: 'headless' as const
    }
    callEnvironmentEnvelope.mockResolvedValue({ ok: true, result: { snapshot } })

    await expect(
      createPtyApi().getMainBufferSnapshot?.('remote:env-1@@terminal-7', {
        scrollbackRows: 250
      })
    ).resolves.toEqual(snapshot)
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith('env-1', 'terminal.bufferSnapshot', {
      terminal: 'terminal-7',
      scrollbackRows: 250
    })
  })

  it('reports runtime PTYs as snapshot-capable without treating transient snapshot loss as unsupported', async () => {
    callEnvironmentEnvelope.mockResolvedValue({
      ok: true,
      result: {
        terminals: [
          { handle: 'terminal-1', ptyId: 'pty-1' },
          { handle: 'terminal-2', ptyId: null }
        ]
      }
    })

    await expect(
      createPtyApi().getAuthoritativeBufferSnapshotCapabilities?.([
        'remote:env-1@@terminal-1',
        'remote:env-1@@terminal-2'
      ])
    ).resolves.toEqual([
      { id: 'remote:env-1@@terminal-1', authoritative: true },
      { id: 'remote:env-1@@terminal-2', authoritative: false }
    ])
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith('env-1', 'terminal.list', {
      handles: ['terminal-1', 'terminal-2'],
      limit: 2,
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  })

  it('routes daemon management through the paired runtime', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({ state: 'healthy', pendingMs: 0 })
      .mockResolvedValueOnce({ sessions: [], degraded: false })
      .mockResolvedValueOnce({ killedCount: 0, remainingCount: 0, killedSessionIds: [] })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ severed: null })
      .mockResolvedValueOnce({ status: 'refused', reason: 'not-severed' })

    const management = createPtyApi().management
    if (!management) {
      throw new Error('Tauri PTY management API is missing')
    }
    await expect(management.asyncIoHealth()).resolves.toEqual({ state: 'healthy', pendingMs: 0 })
    await expect(management.listSessions()).resolves.toEqual({ sessions: [], degraded: false })
    await expect(management.killAll()).resolves.toEqual({
      killedCount: 0,
      remainingCount: 0,
      killedSessionIds: []
    })
    await expect(management.killOne({ sessionId: 'session-1' })).resolves.toEqual({ success: true })
    await expect(management.restart()).resolves.toEqual({ success: true })
    await expect(management.severedDaemon()).resolves.toEqual({ severed: null })
    await expect(
      management.restartSeveredDaemon({ pid: 1, linuxStartTicks: '2', bootId: 'boot' })
    ).resolves.toEqual({ status: 'refused', reason: 'not-severed' })

    expect(callRuntimeResult.mock.calls).toEqual([
      ['terminalDaemon.asyncIoHealth'],
      ['terminalDaemon.listSessions'],
      ['terminalDaemon.killAll'],
      ['terminalDaemon.killOne', { sessionId: 'session-1' }],
      ['terminalDaemon.restart'],
      ['terminalDaemon.severedStatus'],
      ['terminalDaemon.restartSevered', { pid: 1, linuxStartTicks: '2', bootId: 'boot' }]
    ])
  })

  it('routes SSH target mutations through the runtime registry', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({ target: { id: 'ssh-1', label: 'Build host' }, repoReadoptions: [] })
      .mockResolvedValueOnce({ target: { id: 'ssh-1', label: 'Build host' } })
      .mockResolvedValueOnce(undefined)
    const api = createSshApi()

    await expect(
      api.addTarget?.({ target: { label: 'Build host', host: 'build', port: 22, username: 'ci' } })
    ).resolves.toEqual({ target: { id: 'ssh-1', label: 'Build host' }, repoReadoptions: [] })
    await expect(
      api.updateTarget?.({ id: 'ssh-1', updates: { label: 'Build host' } })
    ).resolves.toEqual({
      id: 'ssh-1',
      label: 'Build host'
    })
    await expect(api.removeTarget?.({ id: 'ssh-1' })).resolves.toBeUndefined()

    expect(callRuntimeResult.mock.calls).toEqual([
      [
        'ssh.addTarget',
        { target: { label: 'Build host', host: 'build', port: 22, username: 'ci' } }
      ],
      ['ssh.updateTarget', { targetId: 'ssh-1', target: { label: 'Build host' } }],
      ['ssh.removeTarget', { targetId: 'ssh-1' }]
    ])
  })

  it('routes SSH config browsing, import, resolution, and disconnect through the runtime', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({
        hosts: [],
        totalHostCount: 0,
        newHostCount: 0,
        matchCount: 0,
        hasMore: false
      })
      .mockResolvedValueOnce({ alias: 'dev', hostname: 'dev.example', port: 22, username: 'me' })
      .mockResolvedValueOnce({ targets: [], repoReadoptions: [] })
      .mockResolvedValueOnce({ entries: [], resolvedPath: '/home/me', pathFlavor: 'posix' })
      .mockResolvedValueOnce(undefined)
    const api = createSshApi()

    await api.listConfigHosts?.({ query: 'dev', refresh: true })
    await api.resolveConfigHost?.({ alias: 'dev' })
    await api.importConfig?.({ reAdopt: true })
    await api.browseDir?.({ targetId: 'ssh-1', dirPath: '~' })
    await api.disconnect?.({ targetId: 'ssh-1' })

    expect(callRuntimeResult.mock.calls).toEqual([
      ['ssh.listConfigHosts', { query: 'dev', refresh: true }],
      ['ssh.resolveConfigHost', { alias: 'dev' }],
      ['ssh.importConfig', { reAdopt: true }],
      ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' }],
      ['ssh.disconnect', { targetId: 'ssh-1' }]
    ])
  })

  it('confirms remote-runtime panes through the fresh-scan helper', async () => {
    confirmRuntimeTerminalForegroundProcess.mockResolvedValue('powershell.exe')
    await expect(
      createPtyApi().confirmForegroundProcess?.('remote:env-1@@terminal-9')
    ).resolves.toBe('powershell.exe')
    expect(confirmRuntimeTerminalForegroundProcess).toHaveBeenCalledWith('remote:env-1@@terminal-9')
  })

  it('fails closed for SSH panes without touching the confirm RPC', async () => {
    await expect(createPtyApi().confirmForegroundProcess?.('ssh:build@@pty-1')).resolves.toBeNull()
    expect(confirmRuntimeTerminalForegroundProcess).not.toHaveBeenCalled()
  })

  it('fails closed for ownerless ids instead of recursing into the preload', async () => {
    await expect(createPtyApi().confirmForegroundProcess?.('pty-1')).resolves.toBeNull()
    expect(confirmRuntimeTerminalForegroundProcess).not.toHaveBeenCalled()
  })
})
