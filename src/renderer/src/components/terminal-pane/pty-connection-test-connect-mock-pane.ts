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

/** Connects a mock pane through the real connectPanePty. Imported lazily so a
 *  test's vi.resetModules() hands back the freshly mocked module graph. */
export async function connectMockPanePty(
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
): Promise<PanePtyBinding> {
  const { connectPanePty } = await import('./pty-connection')
  return connectPanePty(...mockPanePtyArgs(pane, manager, deps))
}
