import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../shared/constants'
import { WIN_PATH, WSL_PATH } from '../../../shared/launch-parity-window-cases.test-fixture'
import { launchWorkspaceId } from '../../../shared/launch-parity-window-request.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)

const load = perClientLoader(async () => ({
  launch: await import('@/lib/launch-agent-in-new-tab')
}))

// Pins main's current launch behaviour as the convergence parity baseline (row 1, Q5): C2 must keep,
// or knowingly change, which saved default args stop "+" at the window planner.
describe('"+" saved default args at the window planner', () => {
  beforeAll(async () => {
    await load('win32')
  }, 240_000)

  // The args are re-split for the shell the window quotes for: PowerShell has no backslash escape.
  it.each([
    { path: WIN_PATH, launches: false },
    { path: WSL_PATH, launches: true }
  ])("--x it\\'s on a Windows client at $path: launches=$launches", async ({ path, launches }) => {
    const modules = await load('win32')
    const store = modules.createStore()
    holder.store = store
    const workspace = { kind: 'repo', path } as const
    store.setState(
      launchWorkspaceState(workspace, {
        ...getDefaultSettings('/home/alice'),
        agentDefaultArgs: { claude: String.raw`--x it\'s` }
      })
    )
    const worktreeId = launchWorkspaceId(workspace)
    // Hand-built copy of what the tab-bar "+" menu passes.
    const result = modules.launch.launchAgentInNewTab({
      requestId: 'parity-plus',
      agent: 'claude',
      worktreeId,
      groupId: store.getState().activeGroupIdByWorktree[worktreeId],
      launchSource: 'tab_bar_quick_launch'
    })

    expect(result !== null).toBe(launches)
    const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
    expect(tabs).toHaveLength(launches ? 1 : 0)
    expect(Object.keys(store.getState().pendingStartupByTabId)).toHaveLength(launches ? 1 : 0)
  })
})
