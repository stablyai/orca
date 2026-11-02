// Show server frame status=held in the existing newer-build banner. Reopen asks server main; desktop starts nothing and subsequent cleared/bound frames show recovery.

import type { NewerDaemonReopenResult } from '../../../shared/newer-daemon-hold'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { showServerHeldPanes } from '@/components/terminal-pane/newer-daemon-hold-state'
import { callRuntimeRpc } from './runtime-rpc-client'

/** A held pane under the server's own ids. */
export type ServerHeldPane = { worktreeId: string; tabId: string; leafId: string }

// Why generous: the server stops its newer build's terminal service, then starts each pane.
const REOPEN_TIMEOUT_MS = 60_000

/** Each held terminal pane in the server's layouts, under the server's ids and this desktop's pane key. */
export function serverHeldPanes(
  layouts: Iterable<PublishedWorkspaceLayout>
): { paneKey: string; pane: ServerHeldPane }[] {
  const held: { paneKey: string; pane: ServerHeldPane }[] = []
  for (const layout of layouts) {
    for (const tab of layout.tabs) {
      for (const pane of tab.kind === 'terminal' ? (tab.terminal?.panes ?? []) : []) {
        if (pane.status === 'held' && isTerminalLeafId(pane.leafId)) {
          held.push({
            // The desktop names a server terminal tab by its terminal (server-layout-frame-ids.ts).
            paneKey: makePaneKey(toWebTerminalSurfaceTabId(tab.entityId), pane.leafId),
            pane: { worktreeId: layout.worktreeId, tabId: tab.entityId, leafId: pane.leafId }
          })
        }
      }
    }
  }
  return held
}

/** Shows exactly these held panes of the server's on the banner; none clears them. */
export function showServerLayoutHeldPanes(
  environmentId: string,
  held: readonly { paneKey: string; pane: ServerHeldPane }[]
): void {
  const panes = held.map(({ pane }) => pane)
  showServerHeldPanes(
    environmentId,
    held.map(({ paneKey }) => paneKey),
    () =>
      callRuntimeRpc<NewerDaemonReopenResult>(
        { kind: 'environment', environmentId },
        'layout.reopenHeldPanes',
        { panes },
        { timeoutMs: REOPEN_TIMEOUT_MS }
      ).then((result) => result.reopened === true)
  )
}
