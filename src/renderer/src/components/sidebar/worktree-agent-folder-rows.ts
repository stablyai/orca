import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { Tab } from '../../../../shared/tab-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'

export type WorktreeAgentFolderSection =
  | { type: 'folder'; folder: TabFolderGroup; agents: DashboardAgentRow[] }
  | { type: 'agent'; agent: DashboardAgentRow }

function unifiedTabForAgent(agent: DashboardAgentRow, tabs: readonly Tab[]): Tab | undefined {
  return tabs.find((tab) => tab.id === agent.tab.id || tab.entityId === agent.tab.id)
}

export function buildWorktreeAgentFolderSections(
  rootAgents: readonly DashboardAgentRow[],
  folders: readonly TabFolderGroup[],
  tabs: readonly Tab[]
): WorktreeAgentFolderSection[] {
  if (folders.length === 0 || rootAgents.length === 0) {
    return rootAgents.map((agent) => ({ type: 'agent', agent }))
  }

  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  const folderIdForAgent = (agent: DashboardAgentRow): string | null => {
    const tab = unifiedTabForAgent(agent, tabs)
    const folderId = tab?.folderGroupId
    return folderId && folderById.has(folderId) ? folderId : null
  }

  const emittedFolders = new Set<string>()
  const sections: WorktreeAgentFolderSection[] = []

  for (const agent of rootAgents) {
    const folderId = folderIdForAgent(agent)
    if (!folderId) {
      sections.push({ type: 'agent', agent })
      continue
    }
    if (emittedFolders.has(folderId)) {
      continue
    }
    emittedFolders.add(folderId)
    const folder = folderById.get(folderId)!
    const members = rootAgents.filter((candidate) => folderIdForAgent(candidate) === folderId)
    const order = new Map(folder.tabOrder.map((tabId, index) => [tabId, index]))
    members.sort((left, right) => {
      const leftTab = unifiedTabForAgent(left, tabs)
      const rightTab = unifiedTabForAgent(right, tabs)
      return (
        (order.get(leftTab?.id ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (order.get(rightTab?.id ?? '') ?? Number.MAX_SAFE_INTEGER)
      )
    })
    sections.push({ type: 'folder', folder, agents: members })
  }

  return sections
}
