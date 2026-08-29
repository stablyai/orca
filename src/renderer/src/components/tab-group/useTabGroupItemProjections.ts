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

  return { group, groupTabs, activeTab, terminalTabs, editorItems, browserItems, tabBarOrder }
}
