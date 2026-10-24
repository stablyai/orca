import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveWebRuntimeLeafToNewTab } from './web-runtime-leaf-move'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../store', () => ({ useAppStore: { getState: () => store.state } }))
const REQUEST = {
  worktreeId: WORKTREE_ID,
  sourceTabId: toWebTerminalSurfaceTabId('host-source'),
  targetTabId: toWebTerminalSurfaceTabId('host-target'),
  leafId: 'leaf-a',
  ptyId: 'remote:web-env-1@@term-1'
}
describe('moveWebRuntimeLeafToNewTab', () => {
  beforeEach(() => {
    store.state = {
      repos: [{ id: 'repo', executionHostId: `runtime:${ENVIRONMENT_ID}` }],
      worktreesByRepo: {
        repo: [
          {
            id: WORKTREE_ID,
            repoId: 'repo',
            hostId: `runtime:${ENVIRONMENT_ID}`,
            runtimeOwnerEnvironmentId: ENVIRONMENT_ID
          }
        ]
      }
    }
  })
  afterEach(() => vi.unstubAllGlobals())
  it('asks the host to move the pane by host tab ids and keeps the mirrored pty id', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: true,
      result: { status: 'moved', ptyId: 'host-pty-1' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(REQUEST)).resolves.toEqual({
      status: 'moved',
      ptyId: REQUEST.ptyId
    })
    expect(call.mock.calls[0][0]).toMatchObject({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        sourceTabId: 'host-source',
        targetTabId: 'host-target',
        leafId: 'leaf-a'
      }
    })
  })
  it('falls back to a local-only move when the host lacks the method', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: false,
      error: { code: 'method_not_found', message: 'method_not_found' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(REQUEST)).resolves.toEqual({ status: 'not_held' })
  })
  it('returns null for a worktree no runtime hosts', async () => {
    store.state = { repos: [], worktreesByRepo: {} }
    const call = vi.fn()
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(REQUEST)).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
