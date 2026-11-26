import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../../../../shared/workspace-layout/tab-groups/tab-title-resolution'
import { getEditorDisplayLabel } from '@/components/editor/panel/header/editor-labels'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from '../palette-repo-resolution'
import { resolveOpenTabOccupantAgent } from '../../../agent-session/tab-identity/open-tab-occupant-agent'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '../../display/worktree-default-display-name'
import { collectAgentMetadataFromIndex } from './workspace-tab-agent-metadata'
import {
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  hasOpenFileExecutionHostEvidence,
  isOpenFileOwnedByWorktree,
  isUnifiedTabOwnedByWorktree
} from '../../ownership/unified-tab-host-ownership'
import { isWorkspaceTabContentType } from './workspace-tab-palette-content-type'
import { getActiveUnifiedTabId, isCurrentWorkspaceTab } from './workspace-tab-palette-current-tab'
import { projectedStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { agentTypeToIconAgent } from '../../../../../../shared/agent-status/presentation/agent-type-icon-agent'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type {
  BuildSearchableWorkspaceTabsOptions,
  SearchableWorkspaceTab,
  WorkspaceTabContentType
} from './workspace-tab-search-types'
import {
  createWorkspaceTabBuildScope,
  type WorkspaceTabBuildScope,
  type WorkspaceTabPaletteBuildContext
} from './workspace-tab-palette-build-scope'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

/** One workspace's entries in tab order; `seenTabIdentities` drops a tab an earlier entry already listed. */
export function buildWorktreeTabEntries(
  worktree: Worktree,
  {
    repoMap,
    repoMapByHostIdentity,
    worktreeOrder,
    unifiedTabsByWorktree,
    tabsByWorktree,
    agentStatusByPaneKey,
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
    chatNames,
    terminalLayoutsByTabId,
    paneForegroundAgentByPaneKey
  }: BuildSearchableWorkspaceTabsOptions,
  { openFilesById, agentIndex, documentFor, ambiguousWorktreeIds }: WorkspaceTabBuildScope,
  seenTabIdentities: Set<string>,
  entries: SearchableWorkspaceTab[]
): void {
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
        document: documentFor(tabIdentity, {
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
          sleepingAgentSessionsByPaneKey,
          paneForegroundAgentByPaneKey
        })
      })
      continue
    }
    if (tab.contentType === 'agent-session') {
      const title = projectedStructuredChatTabName(tab, chatNames)
      seenTabIdentities.add(tabIdentity)
      entries.push({
        ...baseEntry,
        title,
        secondaryText: '',
        titleSearchText: title,
        secondarySearchTexts: [],
        typeSearchAliases: ['chat'],
        document: documentFor(tabIdentity, {
          id: tab.id,
          title,
          secondaryTexts: [],
          worktreeName,
          branch,
          repoName,
          typeAliases: ['chat']
        }),
        agentMetadata: [],
        // Why: a chat records its provider, as the tab strip's icon does.
        occupantAgent: agentTypeToIconAgent(tab.agentSessionAgent)
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
        (!(hasOpenFileExecutionHostEvidence(candidate) || ambiguousWorktreeIds.has(worktree.id)) ||
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
      document: documentFor(tabIdentity, {
        id: tab.id,
        title,
        secondaryTexts: [file.relativePath],
        // The absolute path repeats the workspace folder, so it only proves location.
        containerSecondaryTexts: [file.filePath],
        worktreeName,
        branch,
        repoName
      }),
      agentMetadata: [],
      occupantAgent: null
    })
  }
}

export function buildSearchableWorkspaceTabEntries(
  options: BuildSearchableWorkspaceTabsOptions,
  context?: WorkspaceTabPaletteBuildContext
): SearchableWorkspaceTab[] {
  const entries: SearchableWorkspaceTab[] = []
  const seenTabIdentities = new Set<string>()
  const scope = createWorkspaceTabBuildScope(options, context)
  for (const worktree of options.worktrees) {
    buildWorktreeTabEntries(worktree, options, scope, seenTabIdentities, entries)
  }
  return entries
}
