import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { PanePtyBinding } from './pty-connection/pane-pty-binding'
import type { PaneConnectionDeps } from './pty-connection-test-deps'
import type { MockPane, MockPaneManager } from './pty-connection-test-pane-fixtures'

/** The mock pane, manager and deps as the argument tuple connectPanePty declares. */
export function mockPanePtyArgs(
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
): [ManagedPane, PaneManager, PtyConnectionDeps] {
  return [
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures stub every pane member the connection path reads.
    pane as unknown as ManagedPane,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock manager stubs every manager member the connection path calls.
    manager as unknown as PaneManager,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPaneConnectionDeps mirrors PtyConnectionDeps with mock refs and callbacks.
    deps as unknown as PtyConnectionDeps
  ]
}

/** Import lazily so resetModules selects the freshly mocked connection graph. */
export async function connectMockPanePty(
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
): Promise<PanePtyBinding> {
  const { connectPanePty } = await import('./pty-connection')
  return connectPanePty(...mockPanePtyArgs(pane, manager, deps))
}

/** Model mount registration before connect, with one teardown for the binding and tab. */
export async function connectMountedMockPanePty(
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
): Promise<PanePtyBinding> {
  const { registerRuntimeTerminalTab } = await import('@/runtime/mounted-terminal-tab-registry')
  const { connectPanePty } = await import('./pty-connection')
  const args = mockPanePtyArgs(pane, manager, deps)
  pane.container.querySelector = () => null
  manager.getPanes.mockReturnValue([pane])
  const unregister = registerRuntimeTerminalTab({
    tabId: args[2].tabId,
    worktreeId: args[2].worktreeId,
    getManager: () => args[1],
    getContainer: () => null,
    getPtyIdForPane: (id) => args[2].paneTransportsRef.current.get(id)?.getPtyId() ?? null,
    getTabWideAgentHintLeafId: () => null
  })
  try {
    const binding = connectPanePty(...args)
    let mounted = true
    return {
      ...binding,
      dispose() {
        if (mounted) {
          mounted = false
          binding.dispose()
          unregister()
        }
      }
    }
  } catch (error) {
    unregister()
    throw error
  }
}
