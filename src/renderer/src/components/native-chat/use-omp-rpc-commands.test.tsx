// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import { resetOmpRpcCommandCacheForTests, useOmpRpcCommands } from './use-omp-rpc-commands'

const getCommands = vi.fn()

const STATIC = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'help', description: 'Show available commands' }
] as const

const STATE = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'worktree-1',
  folderWorkspaces: [],
  projectGroups: [],
  projects: [],
  repos: [],
  restoredRuntimeHostIdByWorkspaceSessionKey: {},
  settings: {},
  tabsByWorktree: { 'worktree-1': [{ id: 'tab-1', startupCwd: '/work/a' }] },
  worktreesByRepo: { 'repo-1': [{ id: 'worktree-1', path: '/work/a' }] }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetOmpRpcCommandCacheForTests()
  mocks.state = { ...STATE }
  ;(window as unknown as { api: unknown }).api = { ompRpc: { getCommands } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

function render(agent: string, sessionCommands?: readonly { name: string }[] | null) {
  return renderHook(() => useOmpRpcCommands(agent, 'tab-1', STATIC, sessionCommands))
}

describe('useOmpRpcCommands', () => {
  it("shows the owning session's published catalog instead of the probe snapshot", async () => {
    // The probe is cached per cwd for the app's life, so a command the session
    // registered afterwards (reloaded plugin, new extension command) only ever
    // reaches the `/` menu through the session's own available_commands_update.
    getCommands.mockResolvedValue({ ok: true, commands: [{ name: 'stale-probe-entry' }] })
    const hook = render('omp', [{ name: 'reloaded-skill' }])

    await waitFor(() =>
      expect(hook.result.current.map((command) => command.name)).toEqual([
        'reloaded-skill',
        'clear',
        'help'
      ])
    )
    expect(hook.result.current.map((command) => command.name)).not.toContain('stale-probe-entry')
  })

  it('merges the live OMP catalog over the static one', async () => {
    getCommands.mockResolvedValue({
      ok: true,
      commands: [{ name: 'usage', description: 'Show account usage' }]
    })
    const hook = render('omp')

    // First paint is the static catalog, so the `/` menu is never empty.
    expect(hook.result.current).toBe(STATIC)
    await waitFor(() =>
      expect(hook.result.current.map((command) => command.name)).toEqual(['usage', 'clear', 'help'])
    )
    expect(getCommands).toHaveBeenCalledWith({ cwd: '/work/a' })
  })

  it('falls back to the static catalog when the probe fails', async () => {
    getCommands.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    const hook = render('omp')

    await waitFor(() => expect(getCommands).toHaveBeenCalled())
    expect(hook.result.current).toBe(STATIC)
  })

  it('falls back when the IPC call rejects outright', async () => {
    getCommands.mockRejectedValue(new Error('ipc down'))
    const hook = render('omp')

    await waitFor(() => expect(getCommands).toHaveBeenCalled())
    expect(hook.result.current).toBe(STATIC)
  })

  it('falls back when the IPC call throws synchronously', async () => {
    getCommands.mockImplementation(() => {
      throw new Error('renderer released')
    })
    const hook = render('omp')

    await waitFor(() => expect(getCommands).toHaveBeenCalled())
    expect(hook.result.current).toBe(STATIC)
  })

  it('never probes for a non-omp agent', () => {
    const hook = render('claude')
    expect(hook.result.current).toBe(STATIC)
    expect(getCommands).not.toHaveBeenCalled()
  })

  it('reuses one in-flight request across two panes in the same workspace', async () => {
    getCommands.mockResolvedValue({ ok: true, commands: [{ name: 'usage' }] })
    render('omp')
    render('omp')

    await waitFor(() => expect(getCommands).toHaveBeenCalled())
    expect(getCommands).toHaveBeenCalledTimes(1)
  })

  it('serves a later mount from the cache without a second call', async () => {
    getCommands.mockResolvedValue({ ok: true, commands: [{ name: 'usage' }] })
    const first = render('omp')
    await waitFor(() => expect(first.result.current).not.toBe(STATIC))

    const second = render('omp')
    expect(second.result.current.map((command) => command.name)).toContain('usage')
    expect(getCommands).toHaveBeenCalledTimes(1)
  })
})
