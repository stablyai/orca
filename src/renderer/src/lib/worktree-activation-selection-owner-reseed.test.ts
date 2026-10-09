import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { activateAndRevealWorktree } from './worktree-activation'
import * as gate from './worktree-agent-activation-gate'
import { seedEmptyActivatableWorktree } from './worktree-activation-created-agent-test-state'
import { makeWorktree, makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import { worktreeSelectionOwnerForRow } from './worktree-selection-owner'
import { releaseEmptyWorkspaceDefaultSurface } from './empty-workspace-default-surface-claims'
const detection = vi.hoisted(() => ({ open: vi.fn(), awaits: vi.fn(), load: vi.fn() }))
vi.mock('./empty-workspace-default-agent-chat', () => ({
  openDefaultAgentChatInEmptyWorkspace: detection.open,
  emptyWorkspaceDefaultChatAwaitsDetection: detection.awaits,
  loadEmptyWorkspaceDefaultChatDetection: detection.load
}))
vi.mock('./web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))
const initial = useAppStore.getState()
const id = 'repo-1::/workspace/shared'
afterEach(() => {
  releaseEmptyWorkspaceDefaultSurface(id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
it('does not let A detection completion seed B while B inventory gate remains unanswered', async () => {
  const row = (pub: string) =>
    makeWorktree({
      id,
      repoId: 'repo-1',
      path: '/workspace/shared',
      hostId: 'local',
      ...(pub === 'local' ? {} : { runtimeOwnerEnvironmentId: pub }),
      instanceId: pub,
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'local',
        instanceId: pub
      })
    })
  const a = withRepoHostOwnership(row('publisher-a'), 'runtime:publisher-a'),
    b = withRepoHostOwnership(row('local'), 'local')
  seedEmptyActivatableWorktree(a, { extraWorktrees: [b] })
  const ownerA = worktreeSelectionOwnerForRow(a, []),
    ownerB = worktreeSelectionOwnerForRow(b, [])
  if (!ownerA || !ownerB) {
    throw new Error('owners missing')
  }
  const createTab = vi.fn(() => makeTerminalTab({ id: 'seeded-tab', worktreeId: id }))
  useAppStore.setState({ createTab, setActiveTab: vi.fn() })
  vi.stubGlobal('window', { api: { runtime: { call: vi.fn() }, pty: { listSessions: vi.fn() } } })
  let resolveDetection: () => void = () => {}
  const detectionPromise = new Promise<void>((resolve) => {
    resolveDetection = resolve
  })
  let resolveB: (v: 'empty') => void = () => {}
  const bGate = new Promise<'empty'>((resolve) => {
    resolveB = resolve
  })
  vi.spyOn(gate, 'gateWorktreeAgentActivation')
    .mockResolvedValueOnce('empty')
    .mockReturnValueOnce(bGate)
  detection.awaits.mockReturnValueOnce(true).mockReturnValue(false)
  detection.load.mockReturnValue(detectionPromise)
  detection.open.mockReturnValue(null)
  expect(
    activateAndRevealWorktree(id, {
      owner: ownerA,
      navigationIntent: 'user-open',
      notifyHostRuntime: false
    })
  ).toEqual({ primaryTabId: null })
  await flush()
  expect(detection.load).toHaveBeenCalledTimes(1)
  expect(createTab).not.toHaveBeenCalled()
  expect(
    activateAndRevealWorktree(id, {
      owner: ownerB,
      navigationIntent: 'user-open',
      notifyHostRuntime: false
    })
  ).toEqual({ primaryTabId: null })
  expect(useAppStore.getState().activeWorkspaceOwner).toEqual(ownerB)
  resolveDetection()
  await flush()
  expect(createTab).not.toHaveBeenCalled()
  resolveB('empty')
  await flush()
  expect(createTab).toHaveBeenCalledTimes(1)
})
