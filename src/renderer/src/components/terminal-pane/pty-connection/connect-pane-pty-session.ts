import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from '../pty-connection-types'
import type { PtyTransport } from '../pty-transport-types'

// Why: connectPanePty is a single closure factory. The bag lets extracted
// installers share the same mutable bindings without changing call order.
export type ConnectPanePtySession = {
  pane: ManagedPane
  manager: PaneManager
  deps: PtyConnectionDeps
  // Why typed: every PTY write must name its input kind, and the bag's `any` would hide a missing one.
  transport: PtyTransport
  // oxlint-disable-next-line typescript/no-explicit-any -- session bag for mechanical extract
  [key: string]: any
}
