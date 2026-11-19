import { shallow } from 'zustand/shallow'
import type { BuildSearchableWorkspaceTabsOptions } from './workspace-tab-search-types'

type WorkspaceKeyedRecord = Readonly<Record<string, unknown>>

// Records keyed by workspace id (read, never written here); a change to one workspace's value rebuilds only its entries.
const WORKSPACE_KEYED_INPUTS: readonly ((
  options: BuildSearchableWorkspaceTabsOptions
) => WorkspaceKeyedRecord)[] = [
  (options) => options.unifiedTabsByWorktree,
  (options) => options.tabsByWorktree,
  (options) => options.groupsByWorktree,
  (options) => options.activeGroupIdByWorktree,
  (options) => options.activeTabIdByWorktree,
  (options) => options.activeFileIdByWorktree,
  (options) => options.activeTabTypeByWorktree
]

function stableEntryInputs({
  agentStatusByPaneKey: _agentStatusByPaneKey,
  sleepingAgentSessionsByPaneKey: _sleepingAgentSessionsByPaneKey,
  terminalLayoutsByTabId: _terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey: _paneForegroundAgentByPaneKey,
  unifiedTabsByWorktree: _unifiedTabsByWorktree,
  tabsByWorktree: _tabsByWorktree,
  groupsByWorktree: _groupsByWorktree,
  activeGroupIdByWorktree: _activeGroupIdByWorktree,
  activeTabIdByWorktree: _activeTabIdByWorktree,
  activeFileIdByWorktree: _activeFileIdByWorktree,
  activeTabTypeByWorktree: _activeTabTypeByWorktree,
  ...inputs
}: BuildSearchableWorkspaceTabsOptions) {
  return inputs
}

/** Workspace ids whose keyed inputs changed; a record compare costs one identity check per workspace. */
function changedWorkspaceIds(
  previous: BuildSearchableWorkspaceTabsOptions,
  options: BuildSearchableWorkspaceTabsOptions
): Set<string> {
  const changed = new Set<string>()
  for (const read of WORKSPACE_KEYED_INPUTS) {
    const before = read(previous)
    const after = read(options)
    if (before === after) {
      continue
    }
    for (const id in after) {
      if (after[id] !== before[id]) {
        changed.add(id)
      }
    }
    for (const id in before) {
      if (!(id in after)) {
        changed.add(id)
      }
    }
  }
  return changed
}

/** Workspace ids to rebuild when every other entry input is unchanged; null when a full rebuild is needed. */
export function workspaceScopedChanges(
  previous: BuildSearchableWorkspaceTabsOptions,
  options: BuildSearchableWorkspaceTabsOptions
): Set<string> | null {
  return Object.keys(options).length === Object.keys(previous).length &&
    shallow(stableEntryInputs(previous), stableEntryInputs(options))
    ? changedWorkspaceIds(previous, options)
    : null
}
