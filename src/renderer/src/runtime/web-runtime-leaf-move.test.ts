import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveWebRuntimeLeafToNewTab, settleHostPaneMove } from './web-runtime-leaf-move'

import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'
const store = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})
const supports = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: supports }))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refresh
}))
const REQUEST = {
  worktreeId: WORKTREE_ID,
  sourceTabId: toWebTerminalSurfaceTabId('host-source'),
  targetTabId: toWebTerminalSurfaceTabId('host-target'),
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'remote:web-env-1@@term-1'
}
const PLACEMENT = { targetGroupId: 'host-group', index: 0 }
describe('moveWebRuntimeLeafToNewTab', () => {
  beforeEach(() => {
    supports.mockReset()
    refresh.mockReset()
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
  it('tells a refusal, which the host answered, from a lost reply', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const call = vi.fn()
    stubRuntimeEnvironmentBridge({ call })
    call.mockResolvedValueOnce({ id: 'm', ok: true, result: { status: 'not_held' } })
    await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST, PLACEMENT)).resolves.toBe(
      'refused'
    )
    for (const code of ['method_not_found', 'tab_not_found']) {
      call.mockResolvedValueOnce({ id: 'm', ok: false, error: { code, message: code } })
      await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST, PLACEMENT)).resolves.toBe(
        'refused'
      )
    }
    // The bridge answers a lost transport as an error envelope, as runtimeEnvironments.call does.
    for (const code of [
      'runtime_timeout',
      'remote_runtime_unavailable',
      'runtime_rpc_queue_overloaded'
    ]) {
      call.mockResolvedValueOnce({ id: 'm', ok: false, error: { code, message: code } })
      await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST, PLACEMENT)).resolves.toBe(
        'unknown'
      )
    }
  })
  it('reverts a refused move without stopping its terminal and redraws even an unchanged list', async () => {
    const { order, closeTab, transferAgentPaneAuthority } = withRevertSpies()
    await settleHostPaneMove(ENVIRONMENT_ID, REQUEST, 'refused', true)
    // The pane's status and launch records return to the source before the drawn tab goes.
    expect(transferAgentPaneAuthority).toHaveBeenCalledWith({
      fromPaneKey: `${REQUEST.targetTabId}:${REQUEST.leafId}`,
      toPaneKey: `${REQUEST.sourceTabId}:${REQUEST.leafId}`,
      ptyId: REQUEST.ptyId
    })
    expect(order).toEqual(['transfer', 'close'])
    expect(closeTab).toHaveBeenCalledWith(
      REQUEST.targetTabId,
      expect.objectContaining({
        remoteCloseOwnedByHost: true,
        localPtyTeardownOwnedExternally: true
      })
    )
    expect(refresh).toHaveBeenCalledWith(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true
    })
  })
  it('keeps a move whose lost reply the host turns out to have committed', async () => {
    const { closeTab } = withRevertSpies()
    stubRuntimeEnvironmentBridge({ call: vi.fn().mockResolvedValue(hostList('host-target')) })
    await settleHostPaneMove(ENVIRONMENT_ID, REQUEST, 'unknown', true)
    expect(closeTab).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
  it('reverts a move whose lost reply the host did not commit', async () => {
    const { closeTab } = withRevertSpies()
    stubRuntimeEnvironmentBridge({ call: vi.fn().mockResolvedValue(hostList('host-source')) })
    await settleHostPaneMove(ENVIRONMENT_ID, REQUEST, 'unknown', true)
    expect(closeTab).toHaveBeenCalledOnce()
  })
  it('waits for the next snapshot when the host cannot be asked about a lost reply', async () => {
    const { closeTab } = withRevertSpies()
    stubRuntimeEnvironmentBridge({
      call: vi.fn().mockResolvedValue({
        id: 'l',
        ok: false,
        error: { code: 'remote_runtime_unavailable', message: 'remote_runtime_unavailable' }
      })
    })
    await settleHostPaneMove(ENVIRONMENT_ID, REQUEST, 'unknown', true)
    expect(closeTab).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})

function withRevertSpies() {
  const order: string[] = []
  const closeTab = vi.fn(() => order.push('close'))
  const transferAgentPaneAuthority = vi.fn(() => order.push('transfer'))
  store.state = { ...store.state, closeTab, transferAgentPaneAuthority }
  return { order, closeTab, transferAgentPaneAuthority }
}

/** A host list holding the moved leaf in the given host tab. */
function hostList(parentTabId: string) {
  return {
    id: 'l',
    ok: true,
    result: { tabs: [{ type: 'terminal', parentTabId, leafId: REQUEST.leafId }] }
  }
}
