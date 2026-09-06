import { useMemo } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { useAppStore } from '../../store'

type TabGroupAppState = ReturnType<typeof useAppStore.getState>

export type TabGroupWorktreeSnapshot = {
  groups: readonly TabGroup[]
  unifiedTabs: readonly Tab[]
  terminalTabs: readonly TerminalTab[]
  openFiles: TabGroupAppState['openFiles']
  browserTabs: readonly BrowserTabState[]
  expandedPaneByTabId: TabGroupAppState['expandedPaneByTabId']
  terminalLayoutsByTabId: NonNullable<TabGroupAppState['terminalLayoutsByTabId']>
  generatedTabTitlesEnabled: boolean
  mobileEmulatorEnabled: boolean
}

export type GroupEditorItem = OpenFile & { tabId: string }
export type GroupBrowserItem = BrowserTabState & { tabId: string }
export type GroupAgentSessionItem = Tab & { contentType: 'agent-session' }

type TerminalTabItem = TerminalTab & { unifiedTabId: string }

export function useTabGroupItemProjections({
  groupId,
  worktreeId,
  worktreeState
}: {
  groupId: string
  worktreeId: string
  worktreeState: TabGroupWorktreeSnapshot
}) {
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
  // Why indexed like the terminal tabs above: `openFiles` is the global list across every
  // worktree and `tabOrder` is as long as the group, so the per-tab `.find` scans below were
  // quadratic in tab count on a path that reruns whenever any unified tab is written.
  const openFileById = useMemo(
    () => new Map(worktreeState.openFiles.map((item) => [item.id, item])),
    [worktreeState.openFiles]
  )
  const browserTabById = useMemo(
    () => new Map(worktreeState.browserTabs.map((item) => [item.id, item])),
    [worktreeState.browserTabs]
  )
  const groupTabById = useMemo(() => new Map(groupTabs.map((item) => [item.id, item])), [groupTabs])

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
                generatedLabel: item.generatedLabel ?? terminalTab?.generatedTitle,
                defaultTitle: terminalTab?.defaultTitle,
                launchAgent: terminalTab?.launchAgent
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
          const file = openFileById.get(item.entityId)
          return file ? { ...file, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, openFileById]
  )

  const browserItems = useMemo<GroupBrowserItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = browserTabById.get(item.entityId)
          return bt ? { ...bt, tabId: item.id } : null
        })
        .filter((item): item is GroupBrowserItem => item !== null),
    [browserTabById, groupTabs]
  )

  const agentSessionItems = useMemo<GroupAgentSessionItem[]>(
    () =>
      groupTabs.filter(
        (item): item is GroupAgentSessionItem => item.contentType === 'agent-session'
      ),
    [groupTabs]
  )

  const tabBarOrder = useMemo(
    () =>
      (group?.tabOrder ?? []).map((itemId) => {
        const item = groupTabById.get(itemId)
        if (!item) {
          return itemId
        }
        return item.contentType === 'terminal' || item.contentType === 'browser'
          ? item.entityId
          : item.id
      }),
    [group, groupTabById]
  )

  return {
    group,
    groupTabs,
    activeTab,
    terminalTabs,
    editorItems,
    browserItems,
    agentSessionItems,
    tabBarOrder
  }
}
