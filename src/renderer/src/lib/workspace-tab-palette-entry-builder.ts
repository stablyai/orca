import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'
import type { Tab, TabContentType } from '../../../shared/tab-types'
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
import {
  findAmbiguousWorktreeIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

function getActiveUnifiedTabId({
  worktreeId,
  isCurrentWorktree,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  'activeGroupIdByWorktree' | 'activeTabType' | 'groupsByWorktree'
> & { worktreeId: string; isCurrentWorktree: boolean }): string | null {
  if (!isCurrentWorktree) {
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
  isCurrentWorktree,
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
> & {
  tab: Tab & { contentType: WorkspaceTabContentType }
  isCurrentWorktree: boolean
  activeUnifiedTabId: string | null
}): boolean {
  if (!isCurrentWorktree) {
    return false
  }
  if (activeUnifiedTabId) {
    return activeUnifiedTabId === tab.id
  }
  const visibleType = tab.contentType === 'terminal' ? 'terminal' : 'editor'
  const storedType = activeTabTypeByWorktree[tab.worktreeId] ?? activeTabType
  if (storedType !== visibleType) {
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
  ownershipWorktrees,
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
  const seenTabIdentities = new Set<string>()
  const openFilesById = new Map(openFiles.map((file) => [file.id, file]))
  const agentIndex = buildAgentMetadataTabIndex({
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey
  })
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)

  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeName = resolveWorktreeDisplayName(worktree)
    const branch = resolveWorktreeBranchLabel(worktree)
    const worktreeSortIndex =
      worktreeOrder.get(getWorktreeHostIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const isCurrentWorktree = isPaletteCurrentWorktree(
      worktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
    const activeUnifiedTabId = getActiveUnifiedTabId({
      worktreeId: worktree.id,
      isCurrentWorktree,
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
      if (
        !isWorkspaceTabContentType(rawTab.contentType) ||
        !isUnifiedTabOwnedByWorktree(rawTab, worktree, ambiguousWorktreeIds)
      ) {
        continue
      }
      const tab = rawTab as Tab & { contentType: WorkspaceTabContentType }
      const tabIdentity = JSON.stringify([
        getUnifiedTabPaletteExecutionHostId(tab, worktree) ?? null,
        tab.id
      ])
      if (seenTabIdentities.has(tabIdentity)) {
        continue
      }
      const baseEntry = {
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        groupSortIndex: groupOrder.get(tab.groupId) ?? Number.MAX_SAFE_INTEGER,
        tabSortIndex: tabOrder.get(tab.id) ?? tab.sortOrder,
        isCurrentTab: isCurrentWorkspaceTab({
          tab,
          isCurrentWorktree,
          activeTabType,
          activeTabId,
          activeTabIdByWorktree,
          activeFileId,
          activeFileIdByWorktree,
          activeTabTypeByWorktree,
          activeUnifiedTabId
        }),
        isCurrentWorktree
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
            generatedLabel: tab.generatedLabel ?? terminalTab?.generatedTitle,
            defaultTitle: terminalTab?.defaultTitle,
            launchAgent: terminalTab?.launchAgent
          },
          generatedTitlesEnabled,
          terminalTitle
        )
        seenTabIdentities.add(tabIdentity)
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
      seenTabIdentities.add(tabIdentity)
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
