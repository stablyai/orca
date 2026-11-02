import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { PanePtyBinding } from './pty-connection/pane-pty-binding'
import type { PaneConnectionDeps } from './pty-connection-test-deps'
import type { MockPane, MockPaneManager } from './pty-connection-test-pane-fixtures'

/** Connects a mock pane through the real connectPanePty. Imported lazily so a
 *  test's vi.resetModules() hands back the freshly mocked module graph. */
export async function connectMockPanePty(
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
): Promise<PanePtyBinding> {
  const { connectPanePty } = await import('./pty-connection')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures stub every pane member the connection path reads.
  const managedPane = pane as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock manager stubs every manager member the connection path calls.
  const paneManager = manager as unknown as PaneManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPaneConnectionDeps mirrors PtyConnectionDeps with mock refs and callbacks.
  const connectionDeps = deps as unknown as PtyConnectionDeps
  return connectPanePty(managedPane, paneManager, connectionDeps)
}
