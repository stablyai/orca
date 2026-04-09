import { useCallback, useMemo, lazy, Suspense } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

type TabGroupPanelProps = {
  groupId: string
  worktreeId: string
  isFocused: boolean
  // Why: in single-group mode the titlebar portal renders the tab bar, so
  // the inline tab bar inside TabGroupPanel must be hidden to avoid duplicates.
  hasSplitGroups: boolean
  onSplitTab: (tabId: string, direction: 'left' | 'right' | 'up' | 'down') => void
}

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups,
  onSplitTab
}: TabGroupPanelProps): React.JSX.Element {
  // Why: useShallow prevents infinite re-renders — .find()/.filter() create
  // new references on every call, which fails Zustand's Object.is check.
  const group = useAppStore(
    useShallow((s) => (s.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === groupId) ?? null)
  )
  const groupTabs = useAppStore(
    useShallow((s) =>
      (s.unifiedTabsByWorktree[worktreeId] ?? []).filter((t) => t.groupId === groupId)
    )
  )
  const focusGroup = useAppStore((s) => s.focusGroup)
  const activateTab = useAppStore((s) => s.activateTab)
  const closeUnifiedTab = useAppStore((s) => s.closeUnifiedTab)
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs)
  const closeTabsToRight = useAppStore((s) => s.closeTabsToRight)
  const setTabCustomLabel = useAppStore((s) => s.setTabCustomLabel)
  const setUnifiedTabColor = useAppStore((s) => s.setUnifiedTabColor)

  // Bridge: TerminalSlice state for PTY lifecycle
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const createUnifiedTab = useAppStore((s) => s.createUnifiedTab)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveTabType = useAppStore((s) => s.setActiveTabType)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const closeAllFiles = useAppStore((s) => s.closeAllFiles)
  const pinFile = useAppStore((s) => s.pinFile)

  const activeTabId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((t) => t.id === activeTabId) ?? null

  // Convert unified tabs to TerminalTab shape for TabBar compatibility
  const terminalTabs = useMemo(() => {
    return groupTabs
      .filter((t) => t.contentType === 'terminal')
      .map((t) => ({
        id: t.id,
        ptyId: null as string | null,
        worktreeId,
        title: t.label,
        customTitle: t.customLabel,
        color: t.color,
        sortOrder: t.sortOrder,
        createdAt: t.createdAt
      }))
  }, [groupTabs, worktreeId])

  const editorFiles = useMemo(() => {
    const editorTabIds = new Set(
      groupTabs
        .filter(
          (t) =>
            t.contentType === 'editor' ||
            t.contentType === 'diff' ||
            t.contentType === 'conflict-review'
        )
        .map((t) => t.id)
    )
    return openFiles.filter((f) => f.worktreeId === worktreeId && editorTabIds.has(f.id))
  }, [groupTabs, openFiles, worktreeId])

  const worktree = useAppStore(
    useShallow(
      (s) =>
        Object.values(s.worktreesByRepo)
          .flat()
          .find((wt) => wt.id === worktreeId) ?? null
    )
  )

  const handleFocusClick = useCallback(() => {
    focusGroup(worktreeId, groupId)
  }, [focusGroup, worktreeId, groupId])

  const handleActivate = useCallback(
    (tabId: string) => {
      focusGroup(worktreeId, groupId)
      activateTab(tabId)
      setActiveTab(tabId)
      setActiveTabType('terminal')
    },
    [focusGroup, worktreeId, groupId, activateTab, setActiveTab, setActiveTabType]
  )

  // Why: all worktree tabs (not just this group's) are needed to check whether
  // an editor file is still referenced by another group before closing it.
  const allWorktreeTabs = useAppStore(useShallow((s) => s.unifiedTabsByWorktree[worktreeId] ?? []))

  const handleClose = useCallback(
    (tabId: string) => {
      const tab = groupTabs.find((t) => t.id === tabId)
      if (!tab) {
        return
      }
      if (tab.contentType === 'terminal') {
        closeTab(tabId)
      } else {
        // Why: editor tabs share the same ID (filePath) across groups. Only
        // close the OpenFile entry when no OTHER group still references it,
        // otherwise the other group's EditorPanel would lose its file data.
        const otherGroupHasFile = allWorktreeTabs.some(
          (t) => t.id === tabId && t.groupId !== groupId
        )
        if (!otherGroupHasFile) {
          closeFile(tabId)
        }
      }
      // Why: pass groupId so editor tabs (which can share the same filePath ID
      // across split groups) only get removed from THIS group, not all groups.
      closeUnifiedTab(tabId, groupId)
    },
    [groupTabs, allWorktreeTabs, groupId, closeTab, closeFile, closeUnifiedTab]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      const closedIds = closeOtherTabs(tabId)
      // Bridge: also clean up TerminalSlice/EditorSlice for each closed tab
      for (const id of closedIds) {
        const tab = groupTabs.find((t) => t.id === id)
        if (tab?.contentType === 'terminal') {
          closeTab(id)
        } else if (tab) {
          const otherGroupHasFile = allWorktreeTabs.some(
            (t) => t.id === id && t.groupId !== groupId
          )
          if (!otherGroupHasFile) {
            closeFile(id)
          }
        }
      }
    },
    [closeOtherTabs, groupTabs, allWorktreeTabs, groupId, closeTab, closeFile]
  )

  const handleCloseToRight = useCallback(
    (tabId: string) => {
      const closedIds = closeTabsToRight(tabId)
      for (const id of closedIds) {
        const tab = groupTabs.find((t) => t.id === id)
        if (tab?.contentType === 'terminal') {
          closeTab(id)
        } else if (tab) {
          const otherGroupHasFile = allWorktreeTabs.some(
            (t) => t.id === id && t.groupId !== groupId
          )
          if (!otherGroupHasFile) {
            closeFile(id)
          }
        }
      }
    },
    [closeTabsToRight, groupTabs, allWorktreeTabs, groupId, closeTab, closeFile]
  )

  const handleNewTab = useCallback(() => {
    focusGroup(worktreeId, groupId)
    const newTab = createUnifiedTab(worktreeId, 'terminal')
    createTab(worktreeId, newTab.id)
    setActiveTab(newTab.id)
    setActiveTabType('terminal')
  }, [focusGroup, worktreeId, groupId, createUnifiedTab, createTab, setActiveTab, setActiveTabType])

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      handleClose(tabId)
    },
    [consumeSuppressedPtyExit, handleClose]
  )

  const handleActivateFile = useCallback(
    (fileId: string) => {
      focusGroup(worktreeId, groupId)
      activateTab(fileId)
      setActiveFile(fileId)
      setActiveTabType('editor')
    },
    [focusGroup, worktreeId, groupId, activateTab, setActiveFile, setActiveTabType]
  )

  const isActiveTerminal = activeTab?.contentType === 'terminal'
  const isActiveEditor = activeTab?.contentType === 'editor' || activeTab?.contentType === 'diff'

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups ? ` border ${isFocused ? 'border-accent' : 'border-border'}` : ''
      }`}
      onPointerDown={handleFocusClick}
    >
      {/* Why: in single-group mode, the titlebar portal renders the tab bar,
          so the inline version is hidden to avoid duplication. */}
      <div
        className={`items-stretch h-9 shrink-0 border-b border-border bg-card${hasSplitGroups ? ' flex' : ' hidden'}`}
      >
        <TabBar
          tabs={terminalTabs}
          activeTabId={isActiveTerminal ? activeTabId : null}
          worktreeId={worktreeId}
          expandedPaneByTabId={expandedPaneByTabId}
          onActivate={handleActivate}
          onClose={handleClose}
          onCloseOthers={handleCloseOthers}
          onCloseToRight={handleCloseToRight}
          onReorder={() => {}}
          onNewTab={handleNewTab}
          onSetCustomTitle={(tabId, title) => setTabCustomLabel(tabId, title)}
          onSetTabColor={(tabId, color) => setUnifiedTabColor(tabId, color)}
          onTogglePaneExpand={() => {}}
          editorFiles={editorFiles}
          activeFileId={isActiveEditor ? activeTabId : null}
          activeTabType={isActiveTerminal ? 'terminal' : 'editor'}
          onActivateFile={handleActivateFile}
          onCloseFile={(fileId) => handleClose(fileId)}
          onCloseAllFiles={closeAllFiles}
          onPinFile={pinFile}
          onSplitTab={onSplitTab}
        />
      </div>

      {/* Content area */}
      <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Terminal panes for this group's terminal tabs */}
        {groupTabs
          .filter((t) => t.contentType === 'terminal')
          .map((tab) => (
            <TerminalPane
              key={tab.id}
              tabId={tab.id}
              worktreeId={worktreeId}
              cwd={worktree?.path}
              isVisible={tab.id === activeTabId && isActiveTerminal}
              isActive={isFocused && tab.id === activeTabId && isActiveTerminal}
              onPtyExit={(ptyId) => handlePtyExit(tab.id, ptyId)}
              onCloseTab={() => handleClose(tab.id)}
            />
          ))}

        {/* Editor panel for the active editor tab */}
        {isActiveEditor && (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Loading editor...
              </div>
            }
          >
            <EditorPanel activeFileId={activeTabId} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
