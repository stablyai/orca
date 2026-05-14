/* eslint-disable max-lines -- Why: the split-group workspace model intentionally keeps
   group-scoped activation, close, split, and tab-order rules together so the extracted
   controller cannot drift from the TabGroupPanel surface it coordinates. */
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { useAllWorktrees } from '../../store/selectors'
import { createUntitledMarkdownFile } from '../../lib/create-untitled-markdown'
import { getConnectionId } from '../../lib/connection-context'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { destroyWorkspaceWebviews } from '../../store/slices/browser-webview-cleanup'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import { getProjectNotesEntityId } from '../../lib/open-project-notes-tab'
import { requestProjectNotesTabClose } from '../../lib/project-notes-close-request'

export type GroupEditorItem = OpenFile & { tabId: string }
export type GroupBrowserItem = BrowserTabState & { tabId: string }
export type GroupNotesItem = { id: string; label: string; entityId: string; isDirty: boolean }

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []

type TerminalTabItem = {
  id: string
  unifiedTabId: string
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
  const allWorktrees = useAllWorktrees()
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
      expandedPaneByTabId: state.expandedPaneByTabId
    }))
  )

  const focusGroup = useAppStore((state) => state.focusGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
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
  const dropUnifiedTab = useAppStore((state) => state.dropUnifiedTab)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const openFile = useAppStore((state) => state.openFile)

  const group = useMemo(
    () => worktreeState.groups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeState.groups]
  )
  const worktree = useMemo(
    () => allWorktrees.find((candidate) => candidate.id === worktreeId) ?? null,
    [allWorktrees, worktreeId]
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
          unifiedTabId: item.id,
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

  const browserItems = useMemo<GroupBrowserItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = worktreeState.browserTabs.find((candidate) => candidate.id === item.entityId)
          return bt ? { ...bt, tabId: item.id } : null
        })
        .filter((item): item is GroupBrowserItem => item !== null),
    [groupTabs, worktreeState.browserTabs]
  )

  const notesItems = useMemo<GroupNotesItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'notes')
        .map((item) => ({
          id: item.id,
          label: item.label,
          entityId: item.entityId,
          isDirty: item.isDirty === true
        })),
    [groupTabs]
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
        const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === entityId)
        if (file?.isDirty) {
          // Why: split-group close actions bypass Terminal.tsx, but the unsaved
          // confirmation + save/discard ordering must stay centralized there so
          // tab close, bulk close, and window quit share one queueing flow.
          requestEditorFileClose(entityId)
          return false
        }
        closeFile(entityId)
      }
      return true
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
        destroyWorkspaceWebviews(useAppStore.getState().browserPagesByWorkspace, item.entityId)
        closeBrowserTab(item.entityId)
      } else if (item.contentType === 'notes') {
        requestProjectNotesTabClose(item.id, () => {
          closeUnifiedTab(item.id)
          if (!opts?.skipEmptyCheck) {
            leaveWorktreeIfEmpty()
          }
        })
        return
      } else {
        const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
        if (!canCloseTab) {
          return
        }
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
          destroyWorkspaceWebviews(useAppStore.getState().browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
        } else if (item.contentType === 'notes') {
          requestProjectNotesTabClose(item.id, () => {
            closeUnifiedTab(item.id)
          })
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (canCloseTab) {
            closeUnifiedTab(item.id)
          }
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs]
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

  const activateNotes = useCallback(
    (tabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.id === tabId && candidate.contentType === 'notes'
      )
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveTabType('notes')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveTabType, worktreeId]
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
      if (!sourceTab) {
        return
      }

      // Why: for terminals specifically, splitting a single-tab group should
      // still produce a useful split — spawn a fresh terminal in the new pane
      // and leave the existing one behind. Moving the only tab would collapse
      // the split immediately (see the same-group guard in dropUnifiedTab),
      // giving the user nothing; a new terminal preserves the old shortcut
      // flow without duplicating a persistent tab like editors/browsers would.
      if (sourceTab.contentType === 'terminal' && groupTabs.length <= 1) {
        const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
        if (!newGroupId) {
          return
        }
        const terminal = createTab(worktreeId, newGroupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        return
      }

      // Why: split actions MOVE the source tab into the new pane rather than
      // leaving a duplicate in the origin. Delegating to dropUnifiedTab reuses
      // the same split+move path as drag-to-split so keyboard/menu splits and
      // drag splits stay behaviorally identical, including collapsing the
      // origin group if its last tab is the one we just moved.
      dropUnifiedTab(sourceTab.id, { groupId, splitDirection: direction })
    },
    [
      activeTab,
      createEmptySplitGroup,
      createTab,
      dropUnifiedTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveTab,
      setActiveTabType,
      worktreeId
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

  const closeOthers = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      // Why: the store's closeOtherTabs helper unconditionally closes every non-pinned
      // sibling unified tab, including dirty editor tabs — stranding those files in
      // openFiles without a tab if the user cancels the save dialog. Collect the target
      // ids here instead and route them through the same dirty-aware closeMany path
      // used by individual tab closes so the Cancel -> zombie-file hazard is impossible.
      const siblingIds = groupTabs
        .filter((candidate) => candidate.id !== itemId && !candidate.isPinned)
        .map((candidate) => candidate.id)
      closeMany(siblingIds)
    },
    [closeMany, groupTabs]
  )

  const closeToRight = useCallback(
    (itemId: string) => {
      // Why: see closeOthers — the store's closeTabsToRight helper pre-closes dirty
      // editor tabs before the save dialog resolves. Walking the group's tabOrder
      // locally (unifiedTabsByWorktree is append-ordered, not visually ordered, so
      // tabOrder is the canonical left-to-right sequence) and routing through
      // closeMany keeps the dirty-aware flow intact.
      const order = group?.tabOrder ?? []
      const index = order.indexOf(itemId)
      if (index === -1) {
        return
      }
      const tabById = new Map(groupTabs.map((candidate) => [candidate.id, candidate]))
      const rightIds = order.slice(index + 1).filter((id) => {
        const candidate = tabById.get(id)
        return candidate ? !candidate.isPinned : false
      })
      closeMany(rightIds)
    },
    [closeMany, group, groupTabs]
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
    browserItems,
    editorItems,
    notesItems,
    terminalTabs,
    tabBarOrder,
    groupTabs,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateBrowser,
      activateEditor,
      activateNotes,
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      createSplitGroup,
      newBrowserTab: () => {
        const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank'
        createBrowserTab(worktreeId, defaultUrl, {
          title: 'New Browser Tab',
          focusAddressBar: true
        })
      },
      duplicateBrowserTab: (browserTabId: string) => {
        const state = useAppStore.getState()
        const tabs = state.browserTabsByWorktree[worktreeId] ?? []
        const source = tabs.find((t) => t.id === browserTabId)
        if (!source) {
          return
        }
        createBrowserTab(worktreeId, source.url, {
          title: source.title,
          sessionProfileId: source.sessionProfileId
        })
      },
      // Why: split-group actions must target their owning group explicitly.
      // Relying on the ambient activeGroupIdByWorktree breaks keyboard and
      // assistive-tech activation because the "+" menu can be triggered from
      // an unfocused panel without first updating global group focus.
      newFileTab: async () => {
        const path = worktree?.path
        if (!path) {
          return
        }
        try {
          const connectionId = getConnectionId(worktreeId) ?? undefined
          const fileInfo = await createUntitledMarkdownFile(path, worktreeId, connectionId)
          openFile(fileInfo, { preview: false, targetGroupId: groupId })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
        }
      },
      newNotesTab: async (noteId?: string) => {
        const projectId = worktree?.repoId ?? worktreeId
        let label = 'Project Notes'
        if (noteId) {
          try {
            const result = await window.api.notes.show({ projectId, worktreeId, note: noteId })
            label = result.note.title
            await window.api.notes.link({ projectId, worktreeId, note: noteId, kind: 'active' })
          } catch {
            label = 'Project Notes'
          }
        }
        const tab = useAppStore.getState().createUnifiedTab(worktreeId, 'notes', {
          targetGroupId: groupId,
          label,
          // Why: each Project Notes tab is an editor surface, not the note
          // identity itself. Give it a unique entity id so users can keep
          // more than one notes tab open in the same pane.
          entityId: getProjectNotesEntityId(projectId, noteId)
        })
        focusGroup(worktreeId, groupId)
        activateTab(tab.id)
        setActiveTabType('notes')
      },
      newTerminalTab: () => {
        const terminal = createTab(worktreeId, groupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        focusTerminalTabSurface(terminal.id)
      },
      newTerminalWithShell: (shellOverride: string) => {
        const terminal = createTab(worktreeId, groupId, shellOverride)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        focusTerminalTabSurface(terminal.id)
      },
      pinFile,
      setTabColor,
      setTabCustomTitle
    }
  }
}
