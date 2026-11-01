import { useAppStore } from '../../store'
import { captureParkedTerminalBuffers } from './parked-terminal-buffer-capture'

/** Capture remote panes before each park: host capability does not prove retained bytes, and unavailable is not empty. Mutate the caller-owned episode ledger; ordinary bytes remain local (docs/reference/ssh-execution-boundary.md). */
export function captureNewlyParkedTerminalTabs(
  worktreeId: string,
  parkedTabIds: ReadonlySet<string>,
  capturedTabIds: Set<string>
): void {
  for (const tabId of Array.from(capturedTabIds)) {
    if (!parkedTabIds.has(tabId)) {
      capturedTabIds.delete(tabId)
    }
  }
  if (capturedTabIds.size === parkedTabIds.size) {
    return
  }
  // On unhydrated catalogs, over-capture remote candidates; skipping risks no surviving copy (opposite default to worktree-runtime-owner.ts).
  const repos = useAppStore.getState().repos ?? []
  for (const tabId of parkedTabIds) {
    if (capturedTabIds.has(tabId)) {
      continue
    }
    // Capture one tab so incomplete coverage leaves just that tab unmarked for retry.
    // Every-hide captures stay client-local to avoid uploading ordinary park bytes.
    if (captureParkedTerminalBuffers({ worktreeId, tabIds: [tabId], repos, localOnly: true })) {
      capturedTabIds.add(tabId)
    }
  }
}
