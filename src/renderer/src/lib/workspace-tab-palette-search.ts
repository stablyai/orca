import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import type { OpenFile } from '@/store/slices/editor'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'
import type { Tab, TabContentType, TabGroup, TerminalTab, Worktree } from '../../../shared/types'
import {
  collectAgentMetadataForTerminal,
  type AgentMetadata,
  type WorkspaceTabAgentMetadataState
} from './workspace-tab-agent-metadata'
export {
  searchWorkspaceTabs,
  type WorkspaceTabPaletteSearchResult
} from './workspace-tab-palette-results'

export type WorkspaceTabContentType =
  | 'terminal'
  | 'editor'
  | 'diff'
  | 'conflict-review'
  | 'check-details'

export type SearchableWorkspaceTab = {
  tab: Tab & { contentType: WorkspaceTabContentType }
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  groupSortIndex: number
  tabSortIndex: number
  title: string
  secondaryText: string
  titleSearchText: string
  secondarySearchTexts: string[]
  agentMetadata: AgentMetadata[]
  isCurrentTab: boolean
  isCurrentWorktree: boolean
}

type WorkspaceTabPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator' | 'tasks'

export type BuildSearchableWorkspaceTabsOptions = WorkspaceTabAgentMetadataState & {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  tabsByWorktree: Record<string, readonly TerminalTab[] | undefined>
  openFiles: readonly OpenFile[]
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeTabType: WorkspaceTabPaletteActiveTabType
  activeTabId: string | null
  activeTabIdByWorktree: Record<string, string | null | undefined>
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null | undefined>
  activeTabTypeByWorktree: Record<string, WorkspaceTabPaletteActiveTabType | undefined>
  generatedTitlesEnabled: boolean
}

function getActiveUnifiedTabId({
  worktreeId,
  activeWorktreeId,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  'activeGroupIdByWorktree' | 'activeTabType' | 'activeWorktreeId' | 'groupsByWorktree'
> & {
  worktreeId: string
}): string | null {
  if (activeWorktreeId !== worktreeId) {
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
  activeWorktreeId,
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
> & {
  tab: Tab & { contentType: WorkspaceTabContentType }
  activeUnifiedTabId: string | null
}): boolean {
  if (tab.worktreeId !== activeWorktreeId) {
    return false
  }
  const visibleType = tab.contentType === 'terminal' ? 'terminal' : 'editor'
  const storedType = activeTabTypeByWorktree[tab.worktreeId] ?? activeTabType
  if (storedType !== visibleType || activeUnifiedTabId !== tab.id) {
    return false
  }
  if (visibleType === 'terminal') {
    return (activeTabIdByWorktree[tab.worktreeId] ?? activeTabId) === tab.entityId
  }
  return (activeFileIdByWorktree[tab.worktreeId] ?? activeFileId) === tab.entityId
}

function isWorkspaceTabContentType(
  contentType: TabContentType
): contentType is WorkspaceTabContentType {
  return (
    contentType === 'terminal' ||
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

export function buildSearchableWorkspaceTabs({
  worktrees,
  repoMap,
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
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  generatedTitlesEnabled
}: BuildSearchableWorkspaceTabsOptions): SearchableWorkspaceTab[] {
  const entries: SearchableWorkspaceTab[] = []
  const openFilesById = new Map(openFiles.map((file) => [file.id, file]))

  for (const worktree of worktrees) {
    const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
    const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveUnifiedTabId({
      worktreeId: worktree.id,
      activeWorktreeId,
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
      if (!isWorkspaceTabContentType(rawTab.contentType)) {
        continue
      }
      const tab = rawTab as Tab & { contentType: WorkspaceTabContentType }
      const isCurrentTab = isCurrentWorkspaceTab({
        tab,
        activeWorktreeId,
        activeTabType,
        activeTabId,
        activeTabIdByWorktree,
        activeFileId,
        activeFileIdByWorktree,
        activeTabTypeByWorktree,
        activeUnifiedTabId
      })
      const baseEntry = {
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        groupSortIndex: groupOrder.get(tab.groupId) ?? Number.MAX_SAFE_INTEGER,
        tabSortIndex: tabOrder.get(tab.id) ?? tab.sortOrder,
        isCurrentTab,
        isCurrentWorktree: activeWorktreeId === worktree.id
      }

      if (tab.contentType === 'terminal') {
        const terminalTab = terminalTabs.get(tab.entityId)
        const title = terminalTab
          ? resolveTerminalTabTitle(terminalTab, generatedTitlesEnabled, 'Terminal')
          : resolveUnifiedTabLabel(tab, generatedTitlesEnabled, 'Terminal')
        entries.push({
          ...baseEntry,
          title,
          secondaryText: 'Terminal tab',
          titleSearchText: title,
          secondarySearchTexts: ['Terminal tab'],
          agentMetadata: collectAgentMetadataForTerminal({
            terminalTabId: tab.entityId,
            worktreeId: worktree.id,
            agentStatusByPaneKey,
            retainedAgentsByPaneKey,
            sleepingAgentSessionsByPaneKey
          })
        })
        continue
      }

      const file = openFilesById.get(tab.entityId)
      if (!file || file.worktreeId !== worktree.id) {
        continue
      }
      const title = getEditorDisplayLabel(file)
      entries.push({
        ...baseEntry,
        title,
        secondaryText: file.relativePath,
        titleSearchText: title,
        secondarySearchTexts: [file.relativePath, file.filePath],
        agentMetadata: []
      })
    }
  }

  return entries
}
