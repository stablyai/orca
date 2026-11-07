import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import type { TerminalPaneStartupController } from '../controller/use-terminal-pane-startup-actions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { notePendingPaneTitleRename } from '@/runtime/pending-pane-title-renames'

export function usePersistedPaneTitleActions({
  managerRef,
  paneTitlesRef,
  removedTitleLeafIdsRef,
  setPaneTitles,
  tabId,
  worktreeId,
  persistLayoutSnapshot
}: Pick<
  TerminalPaneStartupController,
  | 'managerRef'
  | 'paneTitlesRef'
  | 'removedTitleLeafIdsRef'
  | 'setPaneTitles'
  | 'tabId'
  | 'worktreeId'
> & { persistLayoutSnapshot: () => void }) {
  const removePaneTitleLocally = useCallback(
    (paneId: number) => {
      setPaneTitles((previous) => {
        if (!(paneId in previous)) {
          return previous
        }
        const next = { ...previous }
        delete next[paneId]
        return next
      })
      if (paneId in paneTitlesRef.current) {
        const next = { ...paneTitlesRef.current }
        delete next[paneId]
        paneTitlesRef.current = next
      }
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      if (leafId) {
        removedTitleLeafIdsRef.current.add(leafId)
      }
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot, managerRef, paneTitlesRef, removedTitleLeafIdsRef, setPaneTitles]
  )
  const setPaneTitleLocally = useCallback(
    (paneId: number, title: string) => {
      setPaneTitles((previous) => ({ ...previous, [paneId]: title }))
      paneTitlesRef.current = { ...paneTitlesRef.current, [paneId]: title }
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      if (leafId) {
        removedTitleLeafIdsRef.current.delete(leafId)
      }
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot, managerRef, paneTitlesRef, removedTitleLeafIdsRef, setPaneTitles]
  )
  const showPaneTitle = useCallback(
    (paneId: number, title: string | null): void =>
      title === null ? removePaneTitleLocally(paneId) : setPaneTitleLocally(paneId, title),
    [removePaneTitleLocally, setPaneTitleLocally]
  )
  const changePaneTitle = useCallback(
    (paneId: number, title: string | null) => {
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      const showTitle = (): void => {
        if (leafId) {
          const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
          notePendingPaneTitleRename({ leafId, title, layout })
        }
        showPaneTitle(paneId, title)
      }
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        leafId &&
        sendLayoutCommandToOwner(
          worktreeId,
          { type: 'renamePane', tabId, leafId, title },
          { apply: () => {}, asToday: showTitle }
        )
      ) {
        return
      }
      showTitle()
    },
    [showPaneTitle, tabId, worktreeId, managerRef]
  )
  const removePaneTitle = useCallback(
    (paneId: number) => changePaneTitle(paneId, null),
    [changePaneTitle]
  )
  const handleClearPaneTitleShortcut = useCallback(
    (paneId: number) => {
      if (!paneTitlesRef.current[paneId]) {
        return
      }
      removePaneTitle(paneId)
    },
    [removePaneTitle, paneTitlesRef]
  )
  return { changePaneTitle, showPaneTitle, removePaneTitle, handleClearPaneTitleShortcut }
}
