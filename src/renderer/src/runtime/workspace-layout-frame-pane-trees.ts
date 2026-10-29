// Compare frame pane trees against current store: local held commands can lag subsequent frame drawings; only still-held tabs wait.

import type { AppState } from '@/store/types'
import type { SessionSourceEdit } from '@/store/session-source-edits'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'

type TerminalEdit = SessionSourceEdit<Pick<AppState, 'terminalLayoutsByTabId'>>

/** `layouts` with the frames' trees of `keys`, and the workspaces a held tab still keeps waiting. */
export function terminalLayoutsWithFramePaneTrees(
  edit: TerminalEdit,
  cache: WorkspaceLayoutCache,
  keys: Iterable<string>,
  drawn: (key: string) => boolean
): Set<string> {
  const waiting = new Set<string>()
  for (const key of keys) {
    const layout = cache[key]
    if (!layout || !drawn(key)) {
      continue
    }
    for (const tab of layout.tabs) {
      const root = tab.terminal?.root
      const current = root ? edit.entry('terminalLayoutsByTabId', tab.entityId) : undefined
      if (!root || !current) {
        continue
      }
      if (isTabPaneTreeHeld(tab.entityId)) {
        waiting.add(key)
      } else if (stableJson(current.root) !== stableJson(root)) {
        edit.set('terminalLayoutsByTabId', tab.entityId, { ...current, root })
      }
    }
  }
  return waiting
}
