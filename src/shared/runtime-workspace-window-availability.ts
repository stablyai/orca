import type { RuntimeStatus } from './runtime-types'

// Why: a headed Orca server keeps answering status.get after its workspace window
// closes, so "a status came back" is not evidence that graph-backed workspace work
// will succeed there. desktopWindowStatus is only 'openable' when no live renderer
// window exists (orca-runtime.ts:4806), so pairing it with a non-ready graph is the
// narrow "reachable, but nothing can run" signal: a graph-ready headless serve
// (#6844) and hosts that omit desktopWindowStatus (older builds) stay untouched.
export function isRuntimeWorkspaceWindowClosed(status: RuntimeStatus | null | undefined): boolean {
  if (!status) {
    return false
  }
  return status.graphStatus !== 'ready' && status.desktopWindowStatus === 'openable'
}
