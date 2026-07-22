/* eslint-disable max-lines -- Why: keeps group-scoped activation, close, split, and tab-order rules together with the TabGroupPanel surface. */
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
      // Why: reuse stable EMPTY_* fallbacks; fresh `?? []` arrays break Zustand v5 snapshot identity and cause an infinite render loop.
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID,
      generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      mobileEmulatorEnabled: state.settings?.mobileEmulatorEnabled !== false
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
  // Why: shell identity lives on the terminal tab (not the unified tab) so icons survive default-shell changes.
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
            // Why: rebuilt from the unified-tab model, so copy store-only launchAgent or the provider icon is missing until the first hook.
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
          // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
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
    // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
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
        // Why: host-close a remote-owned browser or a pageless host-mirror (else un-closable); local fallbacks have pages so stay local.
        const shouldCloseOnHost =
          isWebRuntimeSessionActive(runtimeEnvironmentId) &&
          (browserWorkspaceHasRemoteOwner(browserState, item.entityId, runtimeEnvironmentId) ||
            !hasLocalPages)
        if (shouldCloseOnHost) {
          void closeWebRuntimeSessionTab({
            worktreeId,
            tabId: item.id,
            environmentId: runtimeEnvironmentId,
            reason: 'user'
          })
        }
        destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
        closeBrowserTab(item.entityId)
        closeUnifiedTab(item.id)
      } else if (item.contentType === 'simulator') {
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
          // Why: revoke local resume + hook authority before the host removes its canonical tab.
          closeTerminalTab(item.entityId)
          continue
        }
        if (item.contentType === 'browser') {
          // Why: see closeItem — host-close a remote-owned browser or pageless host-mirror; always remove the visible tab.
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
              environmentId: runtimeEnvironmentId,
              reason: 'user'
            })
          }
          destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
          closeUnifiedTab(item.id)
        } else if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'simulator') {
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
      // Why: restore xterm focus to the store-active leaf so keyboard input can't drift to a sibling pane.
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
      // Why: the collapse icon stops pointer propagation, so activate here since the normal tab handler won't have run.
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
      // Why: this Split entry point always seeds a fresh terminal (tab-drag can open other directions).
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
    // Why: closing tabs doesn't remove the group shell; empty split groups are layout state, collapse the placeholder pane here.
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
      // Why: store closeOtherTabs strands dirty files if the save dialog is cancelled; route via closeMany to stay dirty-aware.
      const siblingIds = groupTabs
        .filter((candidate) => candidate.id !== itemId && !candidate.isPinned)
        .map((candidate) => candidate.id)
      closeMany(siblingIds)
    },
    [closeMany, groupTabs]
  )

  const closeToRight = useCallback(
    (itemId: string) => {
      // Why: store closeTabsToRight pre-closes dirty tabs; walk tabOrder (canonical L-to-R) via closeMany to stay dirty-aware.
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
      // Why: target the owning group explicitly; the "+" menu can fire from an unfocused panel without updating global group focus.
      newFileTab: async () => {
        await openNewMarkdownInActiveWorkspace(groupId)
      },
      newTerminalTab: () => {
        void openNewTerminalTabInActiveWorkspace(groupId)
      },
      newTerminalWithShell: (shellOverride: string) => {
        void (async () => {
          const environmentId = getRuntimeEnvironmentIdForWorktree(
            useAppStore.getState(),
            worktreeId
          )
          const outcome = await createWebRuntimeSessionTerminal({
            worktreeId,
            environmentId,
            targetGroupId: groupId,
            command: shellOverride,
            activate: true
          })
          if (outcome.status === 'created' || isWebRuntimeSessionActive(environmentId)) {
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
