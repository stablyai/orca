import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'
import type { Tab, TabContentType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import { isPaletteCurrentWorktree, resolvePaletteRepoForWorktree } from './palette-repo-resolution'
import { resolveOpenTabOccupantAgent } from './open-tab-occupant-agent'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import {
  buildAgentMetadataTabIndex,
  collectAgentMetadataFromIndex
} from './workspace-tab-agent-metadata'
import type {
  BuildSearchableWorkspaceTabsOptions,
  SearchableWorkspaceTab,
  WorkspaceTabContentType
} from './workspace-tab-palette-search'

function getActiveUnifiedTabId({
  worktreeId,
  worktreeHostId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  | 'activeGroupIdByWorktree'
  | 'activeTabType'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'groupsByWorktree'
> & { worktreeId: string; worktreeHostId?: Worktree['hostId'] }): string | null {
  if (
    !isPaletteCurrentWorktree(
      { id: worktreeId, hostId: worktreeHostId },
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
  ) {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  const activeUnifiedTabId = activeGroup?.activeTabId ?? null
  return activeTabType === 'terminal' || activeTabType === 'editor' ? activeUnifiedTabId : null
}

function isCurrentWorkspaceTab({
  tab,
  worktreeHostId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  activeUnifiedTabId
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
> & {
  tab: Tab & { contentType: WorkspaceTabContentType }
  worktreeHostId?: Worktree['hostId']
  activeUnifiedTabId: string | null
}): boolean {
  if (
    !isPaletteCurrentWorktree(
      { id: tab.worktreeId, hostId: worktreeHostId },
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
  ) {
    return false
  }
  const visibleType = tab.contentType === 'terminal' ? 'terminal' : 'editor'
  const storedType = activeTabTypeByWorktree[tab.worktreeId] ?? activeTabType
  if (storedType !== visibleType || activeUnifiedTabId !== tab.id) {
    return false
  }
  return visibleType === 'terminal'
    ? (activeTabIdByWorktree[tab.worktreeId] ?? activeTabId) === tab.entityId
    : (activeFileIdByWorktree[tab.worktreeId] ?? activeFileId) === tab.entityId
}

function isWorkspaceTabContentType(
  contentType: TabContentType
): contentType is WorkspaceTabContentType {
  return ['terminal', 'editor', 'diff', 'conflict-review', 'check-details'].includes(contentType)
}

export function buildSearchableWorkspaceTabEntries({
  worktrees,
  repoMap,
  repoMapByHostIdentity,
  worktreeOrder,
  unifiedTabsByWorktree,
  tabsByWorktree,
  openFiles,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  generatedTitlesEnabled,
  terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey
}: BuildSearchableWorkspaceTabsOptions): SearchableWorkspaceTab[] {
  const entries: SearchableWorkspaceTab[] = []
  const seenTabIds = new Set<string>()
  const openFilesById = new Map(openFiles.map((file) => [file.id, file]))
  const agentIndex = buildAgentMetadataTabIndex({
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey
  })

  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeName = resolveWorktreeDisplayName(worktree)
    const branch = resolveWorktreeBranchLabel(worktree)
    const worktreeSortIndex =
      worktreeOrder.get(getWorktreeHostIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveUnifiedTabId({
      worktreeId: worktree.id,
      worktreeHostId: worktree.hostId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeGroupIdByWorktree,
      groupsByWorktree
    })
    const groups = groupsByWorktree[worktree.id] ?? []
    const groupOrder = new Map(groups.map((group, index) => [group.id, index]))
    const tabOrder = new Map<string, number>()
    for (const group of groups) {
      group.tabOrder.forEach((tabId, index) => tabOrder.set(tabId, index))
    }
    const terminalTabs = new Map((tabsByWorktree[worktree.id] ?? []).map((tab) => [tab.id, tab]))

    for (const rawTab of unifiedTabsByWorktree[worktree.id] ?? []) {
      if (!isWorkspaceTabContentType(rawTab.contentType) || seenTabIds.has(rawTab.id)) {
        continue
      }
      const tab = rawTab as Tab & { contentType: WorkspaceTabContentType }
      const baseEntry = {
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        groupSortIndex: groupOrder.get(tab.groupId) ?? Number.MAX_SAFE_INTEGER,
        tabSortIndex: tabOrder.get(tab.id) ?? tab.sortOrder,
        isCurrentTab: isCurrentWorkspaceTab({
          tab,
          worktreeHostId: worktree.hostId,
          activeWorktreeId,
          activeWorkspaceExecutionHostId,
          activeTabType,
          activeTabId,
          activeTabIdByWorktree,
          activeFileId,
          activeFileIdByWorktree,
          activeTabTypeByWorktree,
          activeUnifiedTabId
        }),
        isCurrentWorktree: isPaletteCurrentWorktree(
          worktree,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        )
      }
      if (tab.contentType === 'terminal') {
        const terminalTab = terminalTabs.get(tab.entityId)
        const terminalTitle = terminalTab
          ? resolveTerminalTabTitle(terminalTab, generatedTitlesEnabled, 'Terminal')
          : 'Terminal'
        const title = resolveUnifiedTabLabel(
          {
            ...tab,
            customLabel: tab.customLabel ?? terminalTab?.customTitle ?? null,
            quickCommandLabel: tab.quickCommandLabel ?? terminalTab?.quickCommandLabel,
            generatedLabel: tab.generatedLabel ?? terminalTab?.generatedTitle
          },
          generatedTitlesEnabled,
          terminalTitle
        )
        seenTabIds.add(tab.id)
        entries.push({
          ...baseEntry,
          title,
          secondaryText: '',
          titleSearchText: title,
          secondarySearchTexts: [],
          typeSearchAliases: ['terminal tab', 'terminal'],
          document: buildPaletteTabDocument({
            id: tab.id,
            title,
            secondaryTexts: [],
            worktreeName,
            branch,
            repoName,
            typeAliases: ['terminal tab', 'terminal']
          }),
          agentMetadata: collectAgentMetadataFromIndex(agentIndex, tab.entityId, worktree.id),
          occupantAgent: resolveOpenTabOccupantAgent({
            tabId: tab.entityId,
            title,
            defaultTitle: terminalTab?.defaultTitle,
            launchAgent: terminalTab?.launchAgent,
            layout: terminalLayoutsByTabId?.[tab.entityId],
            agentStatusByPaneKey,
            retainedAgentsByPaneKey,
            sleepingAgentSessionsByPaneKey,
            paneForegroundAgentByPaneKey
          })
        })
        continue
      }
      const file = openFilesById.get(tab.entityId)
      if (!file || file.worktreeId !== worktree.id) {
        continue
      }
      const title = getEditorDisplayLabel(file)
      seenTabIds.add(tab.id)
      entries.push({
        ...baseEntry,
        title,
        secondaryText: file.relativePath,
        titleSearchText: title,
        secondarySearchTexts: [file.relativePath, file.filePath],
        document: buildPaletteTabDocument({
          id: tab.id,
          title,
          secondaryTexts: [file.relativePath, file.filePath],
          worktreeName,
          branch,
          repoName
        }),
        agentMetadata: [],
        occupantAgent: null
      })
    }
  }
  return entries
}
