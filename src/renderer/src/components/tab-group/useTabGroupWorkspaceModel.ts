/* eslint-disable max-lines -- Why: the split-group workspace model intentionally keeps
   group-scoped activation, close, split, and tab-order rules together so the extracted
   controller cannot drift from the TabGroupPanel surface it coordinates. */
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab
} from '../../../../shared/types'
import { useAppStore } from '../../store'
import { createUntitledMarkdownFile } from '../../lib/create-untitled-markdown'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { destroyPersistentWebview } from '../browser-pane/BrowserPane'

export type GroupEditorItem = OpenFile & { tabId: string }

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_RUNTIME_TERMINAL_TABS: readonly TerminalTab[] = []

type TerminalTabItem = {
  id: string
  ptyId: null
  worktreeId: string
  title: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
}

export function useTabGroupWorkspaceModel({
  groupId,
  worktreeId
}: {
  groupId: string
  worktreeId: string
}) {
  const worktreeState = useAppStore(
    useShallow((state) => ({
      // Why: Zustand v5 expects selector snapshots to be referentially stable
      // when the underlying store state has not changed. Allocating fresh
      // fallback arrays here (`?? []`) makes React think every snapshot is
      // new, which traps the split-group render path in an infinite update loop
      // and blanks the window as soon as TabGroupPanel mounts.
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      runtimeTerminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_RUNTIME_TERMINAL_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId,
      worktree:
        Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === worktreeId) ?? null
    }))
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
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const pinFile = useAppStore((state) => state.pinFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((state) => state.setActiveBrowserTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const copyUnifiedTabToGroup = useAppStore((state) => state.copyUnifiedTabToGroup)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((state) => state.consumeSuppressedPtyExit)
  const openFile = useAppStore((state) => state.openFile)

  const group = useMemo(
    () => worktreeState.groups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeState.groups]
  )
  const groupTabs = useMemo(
    () => worktreeState.unifiedTabs.filter((item) => item.groupId === groupId),
    [groupId, worktreeState.unifiedTabs]
  )
  const activeItemId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((item) => item.id === activeItemId) ?? null

  const terminalTabs = useMemo<TerminalTabItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'terminal')
        .map((item) => ({
          id: item.entityId,
          ptyId: null,
          worktreeId,
          title: item.label,
          customTitle: item.customLabel ?? null,
          color: item.color ?? null,
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
          const file = worktreeState.openFiles.find((candidate) => candidate.id === item.entityId)
          return file ? { ...file, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, worktreeState.openFiles]
  )

  const browserItems = useMemo(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = worktreeState.browserTabs.find((candidate) => candidate.id === item.entityId)
          return bt ?? null
        })
        .filter((item): item is BrowserTabState => item !== null),
    [groupTabs, worktreeState.browserTabs]
  )

  const activeBrowserTab = useMemo(
    () =>
      activeTab?.contentType === 'browser'
        ? (worktreeState.browserTabs.find((bt) => bt.id === activeTab.entityId) ?? null)
        : null,
    [activeTab, worktreeState.browserTabs]
  )

  const runtimeTerminalTabById = useMemo(
    () => new Map(worktreeState.runtimeTerminalTabs.map((tab) => [tab.id, tab])),
    [worktreeState.runtimeTerminalTabs]
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

  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group close actions bypass the legacy Terminal.tsx handlers
    // that used to deselect the worktree when its final visible surface
    // closed. Without the same guard here, the renderer keeps an empty
    // worktree selected and TabGroupPanel has nothing to render, producing a
    // blank workspace instead of Orca's landing screen.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [setActiveWorktree, worktreeId])

  const closeItem = useCallback(
    (itemId: string, opts?: { skipEmptyCheck?: boolean }) => {
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
      if (!opts?.skipEmptyCheck) {
        leaveWorktreeIfEmpty()
      }
    },
    [
      closeBrowserTab,
      closeEditorIfUnreferenced,
      closeTab,
      closeUnifiedTab,
      groupTabs,
      leaveWorktreeIfEmpty
    ]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
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
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, groupTabs]
  )

  const activateTerminal = useCallback(
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

  const activateEditor = useCallback(
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

  const activateBrowser = useCallback(
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

  const createSplitGroup = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId?: string) => {
      const sourceTab =
        groupTabs.find((candidate) =>
          candidate.contentType === 'terminal' || candidate.contentType === 'browser'
            ? candidate.entityId === sourceVisibleTabId
            : candidate.id === sourceVisibleTabId
        ) ?? activeTab

      focusGroup(worktreeId, groupId)
      const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
      if (!newGroupId || !sourceTab) {
        return
      }

      // Why: tab context-menu split actions belong to the visible tab that opened
      // the menu. Keeping that decision inside the workspace model prevents the
      // view layer from re-implementing "which tab is the source?" rules.
      if (sourceTab.contentType === 'terminal') {
        const terminal = createTab(worktreeId, newGroupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        return
      }

      if (sourceTab.contentType === 'browser') {
        const browserTab = worktreeState.browserTabs.find(
          (candidate) => candidate.id === sourceTab.entityId
        )
        if (!browserTab) {
          return
        }
        createBrowserTab(browserTab.worktreeId, browserTab.url, {
          title: browserTab.title,
          sessionProfileId: browserTab.sessionProfileId
        })
        return
      }

      copyUnifiedTabToGroup(sourceTab.id, newGroupId, {
        entityId: sourceTab.entityId,
        label: sourceTab.label,
        customLabel: sourceTab.customLabel,
        color: sourceTab.color,
        isPinned: sourceTab.isPinned
      })
      setActiveFile(sourceTab.entityId)
      setActiveTabType('editor')
    },
    [
      activeTab,
      copyUnifiedTabToGroup,
      createBrowserTab,
      createEmptySplitGroup,
      createTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveFile,
      setActiveTab,
      setActiveTabType,
      worktreeId,
      worktreeState.browserTabs
    ]
  )

  const closeGroup = useCallback(() => {
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      closeItem(item.id, { skipEmptyCheck: true })
    }
    // Why: empty split groups are layout state, not tab state. The workspace
    // model owns collapsing those placeholder panes so views do not need to
    // understand when closing tabs is insufficient to remove a group shell.
    closeEmptyGroup(worktreeId, groupId)
    leaveWorktreeIfEmpty()
  }, [closeEmptyGroup, closeItem, groupId, leaveWorktreeIfEmpty, worktreeId])

  const closeAllEditorTabsInGroup = useCallback(() => {
    for (const item of groupTabs) {
      if (
        item.contentType === 'editor' ||
        item.contentType === 'diff' ||
        item.contentType === 'conflict-review'
      ) {
        closeItem(item.id)
      }
    }
  }, [closeItem, groupTabs])

  const reorderTabBar = useCallback(
    (order: string[]) => {
      if (!group) {
        return
      }
      const itemOrder = order
        .map(
          (visibleId) =>
            groupTabs.find((item) =>
              item.contentType === 'terminal' || item.contentType === 'browser'
                ? item.entityId === visibleId
                : item.id === visibleId
            )?.id
        )
        .filter((value): value is string => Boolean(value))
      const orderedIds = new Set(itemOrder)
      const remainingIds = group.tabOrder.filter((itemId) => !orderedIds.has(itemId))
      reorderUnifiedTabs(groupId, itemOrder.concat(remainingIds))
    },
    [group, groupId, groupTabs, reorderUnifiedTabs]
  )

  const tabBarOrder = useMemo(
    () =>
      (group?.tabOrder ?? []).map((itemId) => {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item) {
          return itemId
        }
        return item.contentType === 'terminal' || item.contentType === 'browser'
          ? item.entityId
          : item.id
      }),
    [group, groupTabs]
  )

  return {
    group,
    activeTab,
    activeBrowserTab,
    browserItems,
    editorItems,
    terminalTabs,
    tabBarOrder,
    groupTabs,
    worktreePath: worktreeState.worktree?.path,
    runtimeTerminalTabById,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateBrowser,
      activateEditor,
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers: (itemId: string) => closeMany(closeOtherTabs(itemId)),
      closeToRight: (itemId: string) => closeMany(closeTabsToRight(itemId)),
      consumeSuppressedPtyExit,
      createSplitGroup,
      newBrowserTab: () => {
        const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank'
        createBrowserTab(worktreeId, defaultUrl, { title: 'New Browser Tab' })
      },
      // Why: split-group actions must target their owning group explicitly.
      // Relying on the ambient activeGroupIdByWorktree breaks keyboard and
      // assistive-tech activation because the "+" menu can be triggered from
      // an unfocused panel without first updating global group focus.
      newFileTab: async () => {
        const path = worktreeState.worktree?.path
        if (!path) {
          return
        }
        try {
          const fileInfo = await createUntitledMarkdownFile(path, worktreeId)
          openFile(fileInfo, { preview: false, targetGroupId: groupId })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
        }
      },
      newTerminalTab: () => {
        const terminal = createTab(worktreeId, groupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
      },
      pinFile,
      reorderTabBar,
      setTabColor,
      setTabCustomTitle
    }
  }
}
