/* eslint-disable max-lines -- Why: group panels intentionally co-locate group-scoped tab chrome, activation/close handlers, and surface rendering so split groups cannot drift into a separate behavior path from the original root group. */
import { lazy, Suspense, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'
import { useAppStore } from '../../store'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import BrowserPane, { destroyPersistentWebview } from '../browser-pane/BrowserPane'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

type GroupEditorItem = OpenFile & { tabId: string }
const EMPTY_GROUPS: readonly never[] = []
const EMPTY_TABS: readonly never[] = []
const EMPTY_RUNTIME_TERMINALS: readonly never[] = []
const EMPTY_BROWSER_TABS: readonly never[] = []

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups
}: {
  groupId: string
  worktreeId: string
  isFocused: boolean
  hasSplitGroups: boolean
}): React.JSX.Element {
  const worktreeGroups = useAppStore(
    useShallow((state) => state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS)
  )
  const worktreeUnifiedTabs = useAppStore(
    useShallow((state) => state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  )
  const openFiles = useAppStore((state) => state.openFiles)
  const worktree = useAppStore(
    useShallow(
      (state) =>
        Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === worktreeId) ?? null
    )
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const closeOtherTabs = useAppStore((state) => state.closeOtherTabs)
  const closeTabsToRight = useAppStore((state) => state.closeTabsToRight)
  const reorderUnifiedTabs = useAppStore((state) => state.reorderUnifiedTabs)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const closeEmptyGroup = useAppStore((state) => state.closeEmptyGroup)
  const createTab = useAppStore((state) => state.createTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setActiveFile = useAppStore((state) => state.setActiveFile)
  const setActiveTabType = useAppStore((state) => state.setActiveTabType)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((state) => state.consumeSuppressedPtyExit)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeAllFiles = useAppStore((state) => state.closeAllFiles)
  const pinFile = useAppStore((state) => state.pinFile)
  const expandedPaneByTabId = useAppStore((state) => state.expandedPaneByTabId)
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const runtimeTerminalTabs = useAppStore(
    (state) => state.tabsByWorktree[worktreeId] ?? EMPTY_RUNTIME_TERMINALS
  )
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((state) => state.setActiveBrowserTab)
  const updateBrowserTabPageState = useAppStore((state) => state.updateBrowserTabPageState)
  const setBrowserTabUrl = useAppStore((state) => state.setBrowserTabUrl)

  const group = useMemo(
    () => worktreeGroups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeGroups]
  )
  const groupTabs = useMemo(
    () => worktreeUnifiedTabs.filter((item) => item.groupId === groupId),
    [groupId, worktreeUnifiedTabs]
  )

  const activeItemId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((item) => item.id === activeItemId) ?? null

  const terminalTabs = useMemo(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'terminal')
        .map((item) => ({
          id: item.entityId,
          ptyId: null,
          worktreeId,
          title: item.label,
          customTitle: item.customLabel,
          color: item.color,
          sortOrder: item.sortOrder,
          createdAt: item.createdAt
        })),
    [groupTabs, worktreeId]
  )

  const editorItems = useMemo<GroupEditorItem[]>(
    () =>
      groupTabs
        .filter(
          (item) =>
            item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review'
        )
        .map((item) => {
          const file = openFiles.find((candidate) => candidate.id === item.entityId)
          return file ? { ...file, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, openFiles]
  )

  const worktreeBrowserTabs = useMemo(
    () => browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    [browserTabsByWorktree, worktreeId]
  )

  const browserItems = useMemo(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = worktreeBrowserTabs.find((candidate) => candidate.id === item.entityId)
          return bt ?? null
        })
        .filter((item): item is BrowserTabState => item !== null),
    [groupTabs, worktreeBrowserTabs]
  )

  const activeBrowserTab = useMemo(
    () =>
      activeTab?.contentType === 'browser'
        ? (worktreeBrowserTabs.find((bt) => bt.id === activeTab.entityId) ?? null)
        : null,
    [activeTab, worktreeBrowserTabs]
  )

  const runtimeTerminalTabById = useMemo(
    () => new Map(runtimeTerminalTabs.map((tab) => [tab.id, tab])),
    [runtimeTerminalTabs]
  )

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review')
      )
      if (!otherReference) {
        closeFile(entityId)
      }
    },
    [closeFile, worktreeId]
  )

  const handleActivateTerminal = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveTab(terminalId)
      setActiveTabType('terminal')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveTab, setActiveTabType, worktreeId]
  )

  const handleActivateEditor = useCallback(
    (tabId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === tabId)
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveFile(item.entityId)
      setActiveTabType('editor')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveFile, setActiveTabType, worktreeId]
  )

  const handleActivateBrowser = useCallback(
    (browserTabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
      )
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveBrowserTab(browserTabId)
      setActiveTabType('browser')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveBrowserTab, setActiveTabType, worktreeId]
  )

  const handleClose = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      if (item.contentType === 'terminal') {
        closeTab(item.entityId)
      } else if (item.contentType === 'browser') {
        destroyPersistentWebview(item.entityId)
        closeBrowserTab(item.entityId)
      } else {
        closeEditorIfUnreferenced(item.entityId, item.id)
        closeUnifiedTab(item.id)
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs]
  )

  const handleCloseGroup = useCallback(() => {
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      if (item.contentType === 'terminal') {
        closeTab(item.entityId)
      } else if (item.contentType === 'browser') {
        destroyPersistentWebview(item.entityId)
        closeBrowserTab(item.entityId)
      } else {
        closeEditorIfUnreferenced(item.entityId, item.id)
        closeUnifiedTab(item.id)
      }
    }
    // Why: split creation can leave intentionally empty groups behind. Closing
    // the group chrome must collapse those placeholders too, not just groups
    // that still own tabs.
    closeEmptyGroup(worktreeId, groupId)
  }, [
    closeBrowserTab,
    closeEditorIfUnreferenced,
    closeEmptyGroup,
    closeTab,
    closeUnifiedTab,
    groupId,
    worktreeId
  ])

  const handleCreateSplitGroup = useCallback(
    (direction: 'right' | 'down') => {
      focusGroup(worktreeId, groupId)
      createEmptySplitGroup(worktreeId, groupId, direction)
    },
    [createEmptySplitGroup, focusGroup, groupId, worktreeId]
  )

  const handleCloseOthers = useCallback(
    (itemId: string) => {
      const closedIds = closeOtherTabs(itemId)
      for (const closedId of closedIds) {
        const item = groupTabs.find((candidate) => candidate.id === closedId)
        if (!item) {
          continue
        }
        if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'browser') {
          destroyPersistentWebview(item.entityId)
          closeBrowserTab(item.entityId)
        } else {
          closeEditorIfUnreferenced(item.entityId, item.id)
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeOtherTabs, closeTab, groupTabs]
  )

  const handleCloseToRight = useCallback(
    (itemId: string) => {
      const closedIds = closeTabsToRight(itemId)
      for (const closedId of closedIds) {
        const item = groupTabs.find((candidate) => candidate.id === closedId)
        if (!item) {
          continue
        }
        if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'browser') {
          destroyPersistentWebview(item.entityId)
          closeBrowserTab(item.entityId)
        } else {
          closeEditorIfUnreferenced(item.entityId, item.id)
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTabsToRight, closeTab, groupTabs]
  )

  const tabBar = (
    <TabBar
      tabs={terminalTabs}
      activeTabId={activeTab?.contentType === 'terminal' ? activeTab.entityId : null}
      worktreeId={worktreeId}
      expandedPaneByTabId={expandedPaneByTabId}
      onActivate={handleActivateTerminal}
      onClose={(terminalId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          handleClose(item.id)
        }
      }}
      onCloseOthers={(terminalId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          handleCloseOthers(item.id)
        }
      }}
      onCloseToRight={(terminalId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          handleCloseToRight(item.id)
        }
      }}
      onReorder={(_, order) => {
        if (!group) {
          return
        }
        const itemOrder = order
          .map(
            (entityId) =>
              groupTabs.find(
                (item) => item.contentType === 'terminal' && item.entityId === entityId
              )?.id
          )
          .filter((value): value is string => Boolean(value))
          .concat(
            group.tabOrder.filter(
              (itemId) =>
                !groupTabs.find((item) => item.contentType === 'terminal' && item.id === itemId)
            )
          )
        reorderUnifiedTabs(groupId, itemOrder)
      }}
      onNewTerminalTab={() => {
        const terminal = createTab(worktreeId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
      }}
      onNewBrowserTab={() => {
        createBrowserTab(worktreeId, 'about:blank', { title: 'New Browser Tab' })
      }}
      onSetCustomTitle={setTabCustomTitle}
      onSetTabColor={setTabColor}
      onTogglePaneExpand={() => {}}
      editorFiles={editorItems}
      browserTabs={browserItems}
      activeFileId={
        activeTab?.contentType === 'terminal' || activeTab?.contentType === 'browser'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : 'editor'
      }
      onActivateFile={handleActivateEditor}
      onCloseFile={handleClose}
      onActivateBrowserTab={handleActivateBrowser}
      onCloseBrowserTab={(browserTabId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
        )
        if (item) {
          handleClose(item.id)
        }
      }}
      onCloseAllFiles={closeAllFiles}
      onPinFile={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        pinFile(item.entityId, item.id)
      }}
      tabBarOrder={(group?.tabOrder ?? []).map((itemId) => {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item) {
          return itemId
        }
        return item.contentType === 'terminal' ? item.entityId : item.id
      })}
      onCreateSplitGroup={handleCreateSplitGroup}
    />
  )

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? ` group/tab-group border ${isFocused ? 'border-accent' : 'border-border'}`
          : ''
      }`}
      onPointerDown={() => focusGroup(worktreeId, groupId)}
    >
      {/* Why: every group, including the initial unsplit root, must render its
          chrome inside the same panel stack. Portaling the first group's tabs
          into the window titlebar created a second vertical frame of reference,
          so the first split appeared to "jump down" when later groups rendered
          inline below it. */}
      <div className="flex items-stretch h-9 shrink-0 border-b border-border bg-card">
        {tabBar}
        {hasSplitGroups && (
          <button
            type="button"
            aria-label="Close tab group"
            title="Close tab group"
            onClick={(event) => {
              event.stopPropagation()
              handleCloseGroup()
            }}
            className="mr-1 my-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground group-hover/tab-group:opacity-100 focus:opacity-100"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {groupTabs
          .filter((item) => item.contentType === 'terminal')
          .map((item) => (
            <TerminalPane
              key={`${item.entityId}-${runtimeTerminalTabById.get(item.entityId)?.generation ?? 0}`}
              tabId={item.entityId}
              worktreeId={worktreeId}
              cwd={worktree?.path}
              isActive={
                isFocused && activeTab?.id === item.id && activeTab.contentType === 'terminal'
              }
              // Why: in multi-group splits, the active terminal in each group
              // must remain visible (display:flex) so the user sees its output,
              // but only the focused group's terminal should receive keyboard
              // input. isVisible controls rendering; isActive controls focus.
              isVisible={activeTab?.id === item.id && activeTab.contentType === 'terminal'}
              onPtyExit={(ptyId) => {
                if (consumeSuppressedPtyExit(ptyId)) {
                  return
                }
                handleClose(item.id)
              }}
              onCloseTab={() => handleClose(item.id)}
            />
          ))}

        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'browser' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor/browser content inside a
                  plain relative pane body instead of the legacy flex column in
                  Terminal.tsx. Anchoring the surface to `absolute inset-0`
                  recreates the bounded viewport those panes expect, so plain
                  overflow containers like MarkdownPreview can actually scroll
                  instead of expanding to content height. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading editor...
                  </div>
                }
              >
                <EditorPanel activeFileId={activeTab.entityId} />
              </Suspense>
            </div>
          )}

        {activeBrowserTab && (
          <div className="absolute inset-0 flex min-h-0 min-w-0">
            <BrowserPane
              browserTab={activeBrowserTab}
              onUpdatePageState={updateBrowserTabPageState}
              onSetUrl={setBrowserTabUrl}
            />
          </div>
        )}
      </div>
    </div>
  )
}
