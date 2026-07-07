/* eslint-disable max-lines -- Why: the split-group workspace model intentionally keeps
   group-scoped activation, close, split, and tab-order rules together so the extracted
   controller cannot drift from the TabGroupPanel surface it coordinates. */
import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab
} from '../../../../shared/types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { destroyWorkspaceWebviews } from '../../store/slices/browser-webview-cleanup'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '../../runtime/web-runtime-session'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { openTabBarEntry, type TabCreateEntryArgs } from '../tab-bar/tab-create-entry-action'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from '@/lib/ensure-simulator-tab'
import { ensureTasksTab, worktreeSupportsTasksTab } from '@/lib/ensure-tasks-tab'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'

export function recordTerminalTabGroupSplit(createdTerminal: TerminalTab | null | undefined): void {
  if (!createdTerminal) {
    return
  }
  useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
}

export type GroupEditorItem = OpenFile & { tabId: string }
export type GroupBrowserItem = BrowserTabState & { tabId: string }

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: NonNullable<
  ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
> = {}

type TerminalTabItem = TerminalTab & { unifiedTabId: string }

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
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID,
      generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      mobileEmulatorEnabled: state.settings?.mobileEmulatorEnabled !== false,
      // Why: pass the selector's subscribed snapshot so the check re-derives
      // when repos resolve, instead of a non-reactive getState() read.
      supportsTasksTab: worktreeSupportsTasksTab(worktreeId, state)
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
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (state) => state.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore(
    (state) => state.openNewMarkdownInActiveWorkspace
  )
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (state) => state.openNewTerminalTabInActiveWorkspace
  )
  const closeFile = useAppStore((state) => state.closeFile)
  const makePreviewFilePermanent = useAppStore((state) => state.makePreviewFilePermanent)
  const pinFile = useAppStore((state) => state.pinFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((state) => state.setActiveBrowserTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)

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
  // Why: split groups render tab labels from unified tabs, but terminal shell
  // identity lives on the terminal tab so icons survive default-shell changes.
  const terminalTabById = useMemo(
    () => new Map(worktreeState.terminalTabs.map((item) => [item.id, item])),
    [worktreeState.terminalTabs]
  )

  const terminalTabs = useMemo<TerminalTabItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'terminal')
        .map((item) => {
          const terminalTab = terminalTabById.get(item.entityId)
          return {
            id: item.entityId,
            unifiedTabId: item.id,
            ptyId: terminalTab?.ptyId ?? null,
            worktreeId,
            title: resolveUnifiedTabLabel(
              {
                ...item,
                quickCommandLabel: item.quickCommandLabel ?? terminalTab?.quickCommandLabel,
                generatedLabel: item.generatedLabel ?? terminalTab?.generatedTitle
              },
              worktreeState.generatedTabTitlesEnabled,
              item.label
            ),
            defaultTitle: terminalTab?.defaultTitle,
            quickCommandLabel: terminalTab?.quickCommandLabel ?? item.quickCommandLabel ?? null,
            generatedTitle: terminalTab?.generatedTitle ?? item.generatedLabel ?? null,
            customTitle: item.customLabel ?? terminalTab?.customTitle ?? null,
            color: item.color ?? terminalTab?.color ?? null,
            sortOrder: item.sortOrder,
            createdAt: item.createdAt,
            generation: terminalTab?.generation,
            shellOverride: terminalTab?.shellOverride,
            startupCwd: terminalTab?.startupCwd,
            // Why: carry the launched agent through the rebuilt tab so the tab
            // bar can show the provider icon before the agent's first hook —
            // this object is reconstructed from the unified-tab model, so any
            // store-only field (like launchAgent) is dropped unless copied here.
            launchAgent: terminalTab?.launchAgent,
            pendingActivationSpawn: terminalTab?.pendingActivationSpawn
          }
        }),
    [groupTabs, terminalTabById, worktreeId, worktreeState.generatedTabTitlesEnabled]
  )

  const editorItems = useMemo<GroupEditorItem[]>(
    () =>
      groupTabs
        .filter(
          (item) =>
            item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review' ||
            item.contentType === 'check-details'
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

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review' ||
            item.contentType === 'check-details')
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
      if (item.isPinned) {
        return
      }
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      if (item.contentType === 'terminal') {
        closeTerminalTab(item.entityId)
        if (!opts?.skipEmptyCheck) {
          leaveWorktreeIfEmpty()
        }
        return
      }
      if (item.contentType === 'browser') {
        const browserState = useAppStore.getState()
        const hasLocalPages = (browserState.browserPagesByWorkspace[item.entityId] ?? []).length > 0
        // Why: ask the host to close (idempotent) for a remote-owned browser, OR
        // for a host-mirror whose local page list is momentarily empty — that
        // pageless case was the bug: it has no remote-owned PAGES so the old gate
        // skipped the host close AND the local close couldn't resolve it, leaving
        // the tab un-closable. A genuine client-local fallback browser always has
        // local pages, so it stays local. Always run local cleanup so the visible
        // tab is removed no matter what.
        const shouldCloseOnHost =
          isWebRuntimeSessionActive(runtimeEnvironmentId) &&
          (browserWorkspaceHasRemoteOwner(browserState, item.entityId, runtimeEnvironmentId) ||
            !hasLocalPages)
        if (shouldCloseOnHost) {
          void closeWebRuntimeSessionTab({
            worktreeId,
            tabId: item.id,
            environmentId: runtimeEnvironmentId
          })
        }
        destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
        closeBrowserTab(item.entityId)
        closeUnifiedTab(item.id)
      } else if (item.contentType === 'simulator' || item.contentType === 'tasks') {
        closeUnifiedTab(item.id)
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
      closeUnifiedTab,
      groupTabs,
      leaveWorktreeIfEmpty,
      worktreeId
    ]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item || item.isPinned) {
          continue
        }
        const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
          useAppStore.getState(),
          worktreeId
        )
        if (item.contentType === 'terminal' && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
          void closeWebRuntimeSessionTab({
            worktreeId,
            tabId: item.entityId,
            environmentId: runtimeEnvironmentId
          })
          continue
        }
        if (item.contentType === 'browser') {
          // Why: see closeItem — host-close a remote-owned browser OR a pageless
          // host-mirror (the dead-end case), keep genuine local fallbacks local,
          // and always remove the visible tab.
          const browserState = useAppStore.getState()
          const hasLocalPages =
            (browserState.browserPagesByWorkspace[item.entityId] ?? []).length > 0
          const shouldCloseOnHost =
            isWebRuntimeSessionActive(runtimeEnvironmentId) &&
            (browserWorkspaceHasRemoteOwner(browserState, item.entityId, runtimeEnvironmentId) ||
              !hasLocalPages)
          if (shouldCloseOnHost) {
            void closeWebRuntimeSessionTab({
              worktreeId,
              tabId: item.id,
              environmentId: runtimeEnvironmentId
            })
          }
          destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
          closeUnifiedTab(item.id)
        } else if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'simulator' || item.contentType === 'tasks') {
          closeUnifiedTab(item.id)
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (canCloseTab) {
            closeUnifiedTab(item.id)
          }
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs, worktreeId]
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
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
        void activateWebRuntimeSessionTab({
          worktreeId,
          tabId: terminalId,
          environmentId: runtimeEnvironmentId
        })
      }
      setActiveTab(terminalId)
      setActiveTabType('terminal')
      const activeLeafId = worktreeState.terminalLayoutsByTabId[terminalId]?.activeLeafId ?? null
      // Why: split terminal tab activation must restore xterm focus to the
      // store-active leaf so keyboard input cannot drift to a sibling pane.
      focusTerminalTabSurface(terminalId, activeLeafId)
    },
    [
      activateTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveTab,
      setActiveTabType,
      worktreeState.terminalLayoutsByTabId,
      worktreeId
    ]
  )

  const toggleTerminalPaneExpand = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (!item) {
        return
      }
      // Why: the tab-bar collapse icon stops pointer propagation, so it does
      // not run the normal tab activation handler before toggling pane layout.
      activateTerminal(terminalId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId: terminalId }
          })
        )
      })
    },
    [activateTerminal, groupTabs]
  )

  const activateEditor = useCallback(
    (tabId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === tabId)
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      if (item.contentType === 'simulator') {
        setActiveTabType('simulator')
        // simulator has no editor file entity
      } else if (item.contentType === 'tasks') {
        setActiveTabType('tasks')
        // tasks has no editor file entity
      } else {
        setActiveFile(item.entityId)
        setActiveTabType('editor')
      }
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
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      if (
        isWebRuntimeSessionActive(runtimeEnvironmentId) &&
        browserWorkspaceHasRemoteOwner(useAppStore.getState(), browserTabId, runtimeEnvironmentId)
      ) {
        void activateWebRuntimeSessionTab({
          worktreeId,
          tabId: item.id,
          environmentId: runtimeEnvironmentId
        })
      }
      setActiveBrowserTab(browserTabId)
      setActiveTabType('browser')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveBrowserTab, setActiveTabType, worktreeId]
  )

  const createSplitGroup = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      focusGroup(worktreeId, groupId)
      const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
      if (!newGroupId) {
        return
      }
      // Why: the tab-strip Split pane control adds a split pane to the right of
      // the group that owns the button. Dragging tabs can still open other
      // directions; this entry point always seeds a fresh terminal.
      const terminal = createTab(worktreeId, newGroupId)
      recordTerminalTabGroupSplit(terminal)
      setActiveTab(terminal.id)
      setActiveTabType('terminal')
    },
    [
      createEmptySplitGroup,
      createTab,
      focusGroup,
      groupId,
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
        item.contentType === 'conflict-review' ||
        item.contentType === 'check-details'
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
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      createSplitGroup,
      newBrowserTab: () => {
        void openNewBrowserTabInActiveWorkspace(groupId)
      },
      newSimulatorTab: worktreeState.mobileEmulatorEnabled
        ? () => {
            if (getSimulatorTabForWorktree(worktreeId)) {
              void ensureSimulatorTab(worktreeId, { surfacePane: true })
              return
            }
            // Why: mobile simulators are most useful beside the current tab group.
            void openMobileEmulatorTab(worktreeId, {
              placement: 'rightSplit',
              targetGroupId: groupId
            })
          }
        : undefined,
      newTasksTab: worktreeState.supportsTasksTab
        ? () => {
            ensureTasksTab(worktreeId, { targetGroupId: groupId })
          }
        : undefined,
      openEntry: async (args: TabCreateEntryArgs) => {
        await openTabBarEntry(args)
      },
      duplicateBrowserTab: (browserTabId: string) => {
        void (async () => {
          const state = useAppStore.getState()
          const tabs = state.browserTabsByWorktree[worktreeId] ?? []
          const source = tabs.find((t) => t.id === browserTabId)
          if (!source) {
            return
          }
          const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
          if (
            browserWorkspaceHasRemoteOwner(state, source.id, runtimeEnvironmentId) &&
            (await createWebRuntimeSessionBrowserTab({
              worktreeId,
              environmentId: runtimeEnvironmentId,
              url: source.url,
              profileId: source.sessionProfileId,
              targetGroupId: groupId
            }))
          ) {
            return
          }
          createBrowserTab(worktreeId, source.url, {
            ...buildDuplicatedBrowserTabOptions(source),
            targetGroupId: groupId
          })
        })()
      },
      // Why: split-group actions must target their owning group explicitly.
      // Relying on the ambient activeGroupIdByWorktree breaks keyboard and
      // assistive-tech activation because the "+" menu can be triggered from
      // an unfocused panel without first updating global group focus.
      newFileTab: async () => {
        await openNewMarkdownInActiveWorkspace(groupId)
      },
      newTerminalTab: () => {
        void openNewTerminalTabInActiveWorkspace(groupId)
      },
      newTerminalWithShell: (shellOverride: string) => {
        void (async () => {
          if (
            await createWebRuntimeSessionTerminal({
              worktreeId,
              environmentId: getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId),
              targetGroupId: groupId,
              command: shellOverride,
              activate: true
            })
          ) {
            return
          }
          const terminal = createTab(worktreeId, groupId, shellOverride)
          setActiveTab(terminal.id)
          setActiveTabType('terminal')
          focusTerminalTabSurface(terminal.id)
        })()
      },
      makePreviewFilePermanent,
      pinFile,
      setTabColor,
      setTabCustomTitle,
      toggleTerminalPaneExpand
    }
  }
}
