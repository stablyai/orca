import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { findTerminalTabWorktreeId } from '@/components/native-chat/native-chat-file-link'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'

function showRuntimePaneTitle(tabId: string, leafId: string, title: string | null): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  // Parked panes have no event listener; their next mount reads this same layout.
  const titlesByLeafId = { ...layout.titlesByLeafId }
  if (title) {
    titlesByLeafId[leafId] = title
  } else {
    delete titlesByLeafId[leafId]
  }
  const { titlesByLeafId: _previousTitles, ...layoutWithoutTitles } = layout
  const nextLayout: TerminalLayoutSnapshot =
    Object.keys(titlesByLeafId).length > 0
      ? { ...layoutWithoutTitles, titlesByLeafId }
      : layoutWithoutTitles
  store.setTabLayout(tabId, nextLayout)
  const detail: SetTerminalPaneTitleDetail = { tabId, leafId, title }
  window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
}

export function applyRuntimePaneTitle({ tabId, leafId, title }: SetTerminalPaneTitleDetail): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  // A never-mounted tab's layout can be rootless and name its one pane elsewhere.
  const leafIds = layout?.root
    ? collectLeafIdsInOrder(layout.root)
    : [layout && resolveRootlessTerminalLayoutLeafId(layout)]
  if (!layout || !isTerminalLeafId(leafId) || !leafIds.includes(leafId)) {
    return
  }
  const normalizedTitle = title?.trim() || null
  if ((layout.titlesByLeafId?.[leafId] ?? null) === normalizedTitle) {
    return
  }
  const show = (): void => showRuntimePaneTitle(tabId, leafId, normalizedTitle)
  const worktreeId = findTerminalTabWorktreeId(store.tabsByWorktree, tabId)
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    worktreeId &&
    sendLayoutCommandToOwner(
      worktreeId,
      { type: 'renamePane', tabId, leafId, title: normalizedTitle },
      { apply: () => {}, asToday: show }
    )
  ) {
    return
  }
  show()
}
