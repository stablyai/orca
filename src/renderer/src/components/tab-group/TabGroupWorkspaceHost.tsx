import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import CodexRestartChip from '../CodexRestartChip'
import TabGroupSplitLayout from './TabGroupSplitLayout'

export default function TabGroupWorkspaceHost({
  activeView,
  activeWorktreeId,
  mountedWorktreeIds,
  titlebarTabsTarget
}: {
  activeView: string
  activeWorktreeId: string
  mountedWorktreeIds: string[]
  titlebarTabsTarget: HTMLElement
}): React.JSX.Element | null {
  const {
    activeBrowserTabId,
    activeFileId,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabType,
    browserTabsByWorktree,
    groupsByWorktree,
    layoutByWorktree,
    openFiles,
    worktreesByRepo
  } = useAppStore(
    useShallow((state) => ({
      activeBrowserTabId: state.activeBrowserTabId,
      activeFileId: state.activeFileId,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      activeTabId: state.activeTabId,
      activeTabType: state.activeTabType,
      browserTabsByWorktree: state.browserTabsByWorktree,
      groupsByWorktree: state.groupsByWorktree,
      layoutByWorktree: state.layoutByWorktree,
      openFiles: state.openFiles,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const ensureWorktreeRootGroup = useAppStore((state) => state.ensureWorktreeRootGroup)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)

  useEffect(() => {
    // Why: the split host depends on the group model being present even when the
    // worktree has only legacy terminal tabs. Keep the bootstrap here so the
    // terminal host only decides which surface path to mount.
    ensureWorktreeRootGroup(activeWorktreeId)
  }, [activeWorktreeId, ensureWorktreeRootGroup])

  const allWorktrees = useMemo(() => Object.values(worktreesByRepo).flat(), [worktreesByRepo])
  const worktreeFiles = openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  const worktreeBrowserTabs = browserTabsByWorktree[activeWorktreeId] ?? []
  const activeWorktree = allWorktrees.find((worktree) => worktree.id === activeWorktreeId) ?? null
  const activeTerminalTab = (tabsByWorktree[activeWorktreeId] ?? []).find(
    (tab) => tab.id === activeTabId
  )
  const activeEditorFile = worktreeFiles.find((file) => file.id === activeFileId) ?? null
  const activeBrowserTab = worktreeBrowserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null
  const activeSurfaceLabel =
    activeTabType === 'browser'
      ? (activeBrowserTab?.title ?? activeBrowserTab?.url ?? 'Browser')
      : activeTabType === 'editor'
        ? (activeEditorFile?.relativePath ?? activeEditorFile?.filePath ?? 'Editor')
        : (activeTerminalTab?.customTitle ?? activeTerminalTab?.title ?? 'Terminal')

  const getEffectiveLayoutForWorktree = useCallback(
    (worktreeId: string) => {
      const layout = layoutByWorktree[worktreeId]
      if (layout) {
        return layout
      }
      const groups = groupsByWorktree[worktreeId] ?? []
      const fallbackGroupId = activeGroupIdByWorktree[worktreeId] ?? groups[0]?.id ?? null
      if (!fallbackGroupId) {
        return undefined
      }
      return { type: 'leaf', groupId: fallbackGroupId } as const
    },
    [activeGroupIdByWorktree, groupsByWorktree, layoutByWorktree]
  )

  const effectiveActiveLayout = getEffectiveLayoutForWorktree(activeWorktreeId)
  if (!effectiveActiveLayout) {
    return null
  }

  return (
    <>
      {createPortal(
        <div className="flex h-full min-w-0 items-center px-3 text-xs text-muted-foreground">
          {/* Why: split layouts render a real tab row per group, so the titlebar
              should only show lightweight workspace context instead of trying to
              own tab selection for multiple groups at once. */}
          <span className="truncate font-medium text-foreground/80">
            {activeWorktree?.displayName ?? 'Workspace'}
          </span>
          <span className="px-2 text-border">/</span>
          <span className="truncate">{activeSurfaceLabel}</span>
        </div>,
        titlebarTabsTarget
      )}

      <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
        {allWorktrees
          .filter((worktree) => mountedWorktreeIds.includes(worktree.id))
          .map((worktree) => {
            const layout = getEffectiveLayoutForWorktree(worktree.id)
            if (!layout) {
              return null
            }
            const isVisible = activeView !== 'settings' && worktree.id === activeWorktreeId
            return (
              <div
                key={`tab-groups-${worktree.id}`}
                className={isVisible ? 'absolute inset-0 flex' : 'absolute inset-0 hidden'}
                aria-hidden={!isVisible}
              >
                <CodexRestartChip worktreeId={worktree.id} />
                <TabGroupSplitLayout
                  layout={layout}
                  worktreeId={worktree.id}
                  focusedGroupId={activeGroupIdByWorktree[worktree.id]}
                />
              </div>
            )
          })}
      </div>
    </>
  )
}
