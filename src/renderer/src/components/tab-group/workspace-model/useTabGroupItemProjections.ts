import { workerTabStripOrder } from '../../../../../shared/workspace-layout/tab-groups/worker-tab-strip-order'
import { useMemo } from 'react'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveUnifiedTabLabel } from '../../../../../shared/workspace-layout/tab-groups/tab-title-resolution'
import { isInertWorkerStamp } from '../../tab-bar/worker-tab-leaves'
import type { useAppStore } from '../../../store/index'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { openFileIndex } from '@/store/slices/editor/tabs/workspace-editor-files'

type TabGroupAppState = ReturnType<typeof useAppStore.getState>

export type TabGroupWorktreeSnapshot = {
  groups: readonly TabGroup[]
  unifiedTabs: readonly Tab[]
  terminalTabs: readonly TerminalTab[]
  openFiles: TabGroupAppState['openFiles']
  browserTabs: readonly BrowserWorkspace[]
  expandedPaneByTabId: TabGroupAppState['expandedPaneByTabId']
  terminalLayoutsByTabId: NonNullable<TabGroupAppState['terminalLayoutsByTabId']>
  generatedTabTitlesEnabled: boolean
  mobileEmulatorEnabled: boolean
}

export type GroupEditorItem = OpenFile & { tabId: string }
export type GroupBrowserItem = BrowserWorkspace & { tabId: string }
export type GroupAgentSessionItem = Tab & { contentType: 'agent-session' }

type TerminalTabItem = TerminalTab & { unifiedTabId: string }

export function useTabGroupItemProjections({
  groupId,
  worktreeId,
  worktreeState,
  foldedTabIds,
  peekTabId
}: {
  groupId: string
  worktreeId: string
  worktreeState: TabGroupWorktreeSnapshot
  /** Worker tabs folded out of this pane's strip; they stay in `groupTabs` for close and activation. */
  foldedTabIds?: ReadonlySet<string>
  peekTabId?: string
}) {
  const group = useMemo(
    () => worktreeState.groups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeState.groups]
  )
  const groupTabs = useMemo(
    () => worktreeState.unifiedTabs.filter((item) => item.groupId === groupId),
    [groupId, worktreeState.unifiedTabs]
  )
  const stripTabs = useMemo(
    () =>
      foldedTabIds && foldedTabIds.size > 0
        ? groupTabs.filter((item) => !foldedTabIds.has(item.id))
        : groupTabs,
    [foldedTabIds, groupTabs]
  )
  const activeItemId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((item) => item.id === activeItemId) ?? null
  // Why: shell identity lives on the terminal tab (not the unified tab) so icons survive default-shell changes.
  const terminalTabById = useMemo(
    () => new Map(worktreeState.terminalTabs.map((item) => [item.id, item])),
    [worktreeState.terminalTabs]
  )
  const browserTabById = useMemo(
    () => new Map(worktreeState.browserTabs.map((item) => [item.id, item])),
    [worktreeState.browserTabs]
  )
  const groupTabById = useMemo(() => new Map(groupTabs.map((item) => [item.id, item])), [groupTabs])

  // Keyed by id so a layout change (a split drag) rebuilds the strip only when a stamp actually retires.
  const inertWorkerKey = useMemo(
    () =>
      stripTabs
        .filter((item) => isInertWorkerStamp(worktreeState, item))
        .map((item) => item.id)
        .join('\0'),
    [stripTabs, worktreeState]
  )
  const terminalTabs = useMemo<TerminalTabItem[]>(() => {
    const inertWorkerIds = new Set(inertWorkerKey ? inertWorkerKey.split('\0') : [])
    return stripTabs
      .filter((item) => item.contentType === 'terminal')
      .map((stamped) => {
        // A stamp whose worker pane closed leaves the user's tab: its own title, no worker chrome.
        const item = inertWorkerIds.has(stamped.id) ? { ...stamped, workerTab: undefined } : stamped
        const terminalTab = terminalTabById.get(item.entityId)
        return {
          id: item.entityId,
          unifiedTabId: item.id,
          ...(item.workerTab ? { workerTab: item.workerTab } : {}),
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
          // Why: the strip re-resolves this title; without the session title the first-prompt title wins.
          aiVaultTitle: item.aiVaultTitle ?? terminalTab?.aiVaultTitle ?? null,
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
      })
  }, [
    stripTabs,
    terminalTabById,
    worktreeId,
    worktreeState.generatedTabTitlesEnabled,
    inertWorkerKey
  ])

  const editorItems = useMemo<GroupEditorItem[]>(
    () =>
      groupTabs
        .filter((item) => isEditorTabContentType(item.contentType))
        .map((item): GroupEditorItem | null => {
          const file = openFileIndex(worktreeState.openFiles).get(item.entityId)
          return file ? { ...file, isPreview: item.isPreview, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, worktreeState.openFiles]
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
      stripTabs.filter(
        (item): item is GroupAgentSessionItem => item.contentType === 'agent-session'
      ),
    [stripTabs]
  )

  const tabBarOrder = useMemo(() => {
    const order = workerTabStripOrder(
      (group?.tabOrder ?? []).filter((id) => !foldedTabIds?.has(id)),
      groupTabs,
      peekTabId
    )
    return order.map((id) => {
      const item = groupTabById.get(id)
      return item?.contentType === 'terminal' || item?.contentType === 'browser'
        ? item.entityId
        : id
    })
  }, [foldedTabIds, group, groupTabById, groupTabs, peekTabId])

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
