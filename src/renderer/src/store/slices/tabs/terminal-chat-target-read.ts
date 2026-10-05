import type { AppState } from '../../types'
import { terminalLayoutNodeLeafIds } from '../../../../../shared/native-chat-leaf-ownership'
import {
  isComposerChatTarget,
  type NativeChatTargetRead
} from '../../../../../shared/native-chat-target-read'
import { readTerminalChatViewMode } from './terminal-chat-pair-state'
import { readTerminalPresentationToken } from './terminal-presentation-stamp'

type TargetReadState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
>

/**
 * Whether this store's committed state lets a composer write reach `ptyId`: the pane bound to it
 * must still be its tab's chat target. Read-only; never consults a pending overlay or a snapshot.
 */
export function readNativeChatTargetFromStore(
  state: TargetReadState,
  ptyId: string
): NativeChatTargetRead {
  for (const rows of Object.values(state.tabsByWorktree ?? {})) {
    for (const row of rows) {
      const layout = state.terminalLayoutsByTabId[row.id]
      const leafIds = terminalLayoutNodeLeafIds(layout?.root)
      const boundLeaf =
        Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
          ([leafId, boundPtyId]) =>
            boundPtyId === ptyId && (leafIds.length === 0 || leafIds.includes(leafId))
        )?.[0] ?? (leafIds.length <= 1 && row.ptyId === ptyId ? (leafIds[0] ?? '') : null)
      if (boundLeaf === null) {
        continue
      }
      const allowed = isComposerChatTarget({
        viewMode: readTerminalChatViewMode(state, row.id),
        chatLeafId: layout?.chatLeafId,
        launchAgent: row.launchAgent,
        leafIds,
        leafId: boundLeaf
      })
      return allowed
        ? { kind: 'chat-target', presentationToken: readTerminalPresentationToken(row.id, ptyId) }
        : { kind: 'not-chat-target' }
    }
  }
  return { kind: 'unknown-target' }
}
