import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { WorkspaceDecisionInputs } from './workspace-space-decision-details'
import { getPaneKeyTabId } from './workspace-space-presentation'

type GroupedInputs = Pick<
  WorkspaceDecisionInputs,
  'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId' | 'retainedAgentsByPaneKey' | 'openFiles'
>

type Bucket = {
  agentStatuses: [string, WorkspaceDecisionInputs['agentStatusByPaneKey'][string]][]
  migrations: [string, WorkspaceDecisionInputs['migrationUnsupportedByPtyId'][string]][]
  retainedAgents: [string, WorkspaceDecisionInputs['retainedAgentsByPaneKey'][string]][]
  openFiles: WorkspaceDecisionInputs['openFiles'][number][]
}

export function groupWorkspaceSpaceDecisionInputs(
  rows: readonly Pick<WorkspaceSpaceWorktree, 'worktreeId'>[],
  tabsByWorktree: Record<string, readonly TerminalTab[]>,
  inputs: GroupedInputs
): Map<string, GroupedInputs> {
  const result = new Map<string, GroupedInputs>()
  if (rows.length === 0) {
    return result
  }
  const buckets = new Map<string, Bucket>()
  const tabOwners = new Map<string, Set<string>>()
  for (const row of rows) {
    if (buckets.has(row.worktreeId)) {
      continue
    }
    buckets.set(row.worktreeId, {
      agentStatuses: [],
      migrations: [],
      retainedAgents: [],
      openFiles: []
    })
    for (const tab of tabsByWorktree[row.worktreeId] ?? []) {
      let owners = tabOwners.get(tab.id)
      if (!owners) {
        owners = new Set()
        tabOwners.set(tab.id, owners)
      }
      owners.add(row.worktreeId)
    }
  }
  for (const [key, entry] of Object.entries(inputs.agentStatusByPaneKey)) {
    const tabId = getPaneKeyTabId(entry.paneKey || key)
    if (!tabId) {
      continue
    }
    for (const owner of tabOwners.get(tabId) ?? []) {
      buckets.get(owner)?.agentStatuses.push([key, entry])
    }
  }
  for (const [key, entry] of Object.entries(inputs.migrationUnsupportedByPtyId)) {
    const tabId = entry.tabId ?? (entry.paneKey ? getPaneKeyTabId(entry.paneKey) : null)
    const owners = new Set(tabId ? tabOwners.get(tabId) : undefined)
    if (entry.worktreeId !== undefined && buckets.has(entry.worktreeId)) {
      owners.add(entry.worktreeId)
    }
    for (const owner of owners) {
      buckets.get(owner)?.migrations.push([key, entry])
    }
  }
  for (const [key, entry] of Object.entries(inputs.retainedAgentsByPaneKey)) {
    buckets.get(entry.worktreeId)?.retainedAgents.push([key, entry])
  }
  for (const file of inputs.openFiles) {
    buckets.get(file.worktreeId)?.openFiles.push(file)
  }
  for (const [id, bucket] of buckets) {
    result.set(id, {
      agentStatusByPaneKey: Object.fromEntries(bucket.agentStatuses),
      migrationUnsupportedByPtyId: Object.fromEntries(bucket.migrations),
      retainedAgentsByPaneKey: Object.fromEntries(bucket.retainedAgents),
      openFiles: bucket.openFiles
    })
  }
  return result
}
