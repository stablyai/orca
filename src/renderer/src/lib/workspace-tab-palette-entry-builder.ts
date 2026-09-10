import { getActiveUnifiedTabId, isCurrentWorkspaceTab } from './workspace-tab-palette-current-tab'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'
import type { Tab } from '../../../shared/tab-types'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from './palette-repo-resolution'
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
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  hasOpenFileExecutionHostEvidence,
  isOpenFileOwnedByWorktree,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import type { OpenFile } from '@/store/slices/editor'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { isWorkspaceTabContentType } from './workspace-tab-palette-content-type'

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
  const openFilesById = new Map<string, OpenFile[]>()
  for (const file of openFiles) {
    const bucket = openFilesById.get(file.id)
    if (bucket) {
      bucket.push(file)
    } else {
      openFilesById.set(file.id, [file])
    }
  }
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
      worktreeOrder.get(getPaletteWorktreeIdentity(worktree)) ??
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
    const terminalTabs = new Map<string, TerminalTab | null>()
    for (const terminalTab of tabsByWorktree[worktree.id] ?? []) {
      terminalTabs.set(terminalTab.id, terminalTabs.has(terminalTab.id) ? null : terminalTab)
    }

    const unifiedTabs = unifiedTabsByWorktree[worktree.id] ?? []
    const duplicateTabIds = findDuplicateIds(unifiedTabs)
    for (const rawTab of unifiedTabs) {
      if (
        duplicateTabIds.has(rawTab.id) ||
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
        if (terminalTab === null) {
          continue
        }
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
          agentMetadata: collectAgentMetadataFromIndex(
            agentIndex,
            tab.entityId,
            worktree,
            ambiguousWorktreeIds
          ),
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
      if (tab.contentType === 'database') {
        const title = resolveUnifiedTabLabel(tab, generatedTitlesEnabled, 'Database Query')
        const secondaryText = tab.database?.connection.database ?? ''
        const typeSearchAliases = ['database', 'SQL', 'PostgreSQL']
        seenTabIdentities.add(tabIdentity)
        entries.push({
          ...baseEntry,
          title,
          secondaryText,
          titleSearchText: title,
          secondarySearchTexts: [secondaryText],
          typeSearchAliases,
          document: buildPaletteTabDocument({
            id: tab.id,
            title,
            secondaryTexts: [secondaryText],
            worktreeName,
            branch,
            repoName,
            typeAliases: typeSearchAliases
          }),
          agentMetadata: [],
          occupantAgent: null
        })
        continue
      }
      const files = openFilesById.get(tab.entityId)
      if (files?.length !== 1) {
        continue
      }
      const file = files.find(
        (candidate) =>
          candidate.worktreeId === worktree.id &&
          (!(
            hasOpenFileExecutionHostEvidence(candidate) || ambiguousWorktreeIds.has(worktree.id)
          ) ||
            isOpenFileOwnedByWorktree(candidate, worktree))
      )
      if (!file) {
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
