import { pruneGroupLayoutLeaves } from '../workspace-session-terminal-tab-close'
import { filterRecord } from './stored-record-fields'
import type { CommandOf, LayoutCommandResult } from './workspace-layout-command-types'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

type RefusedClose = NonNullable<LayoutCommandResult['refused']>[number]

/** Several chat tabs closed as one change, with the model, `closed` and refusals that closing
 *  each in command order gives, in one pass over the workspace and one copy of its map. Null
 *  when the command is a single tab or names any tab here that is not a chat; those close per tab. */
export function closeChatTabsTogether(
  model: WorkspaceLayoutModel,
  command: CommandOf<'closeTabs'>
): {
  model: WorkspaceLayoutModel
  closed: string[]
  missing: string[]
  refused: RefusedClose[]
} | null {
  const workspace = model.workspaces[command.workspace]
  if (!workspace || command.tabIds.length < 2) {
    return null
  }
  const byId = new Map(workspace.tabs.map((tab) => [tab.id, tab]))
  const closing = new Set<string>()
  const closed: string[] = []
  const missing: string[] = []
  const refused: RefusedClose[] = []
  for (const tabId of command.tabIds) {
    const tab = closing.has(tabId) ? undefined : byId.get(tabId)
    if (!tab) {
      closed.push(tabId)
      missing.push(tabId)
      continue
    }
    if (tab.kind !== 'agent-session') {
      return null
    }
    if (!command.force && command.refusePinned && tab.isPinned) {
      refused.push({ tabId, code: 'tab_pinned' })
      continue
    }
    if (!command.force && command.dirtyTabIds?.includes(tabId)) {
      refused.push({ tabId, code: 'editor_tab_has_unsaved_draft' })
      continue
    }
    closing.add(tabId)
    closed.push(tabId)
  }
  if (closing.size === 0) {
    return { model, closed, missing, refused }
  }
  // The groups these closes empty leave the tree together, in one pass over it.
  const emptied = new Set<string>()
  const groups = workspace.groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((id) => !closing.has(id))
    if (tabOrder.length === group.tabOrder.length) {
      return [group]
    }
    if (tabOrder.length === 0) {
      emptied.add(group.id)
      return []
    }
    return [{ ...group, tabOrder }]
  })
  const groupLayout =
    emptied.size > 0
      ? pruneGroupLayoutLeaves(workspace.groupLayout, (groupId) => !emptied.has(groupId))
      : workspace.groupLayout
  const next: WorkspaceLayout = {
    ...workspace,
    tabs: workspace.tabs.filter((tab) => !closing.has(tab.id)),
    groups
  }
  if (groupLayout) {
    next.groupLayout = groupLayout
  } else {
    delete next.groupLayout
  }
  if (next.editorViews) {
    next.editorViews = filterRecord(next.editorViews, (tabId) => !closing.has(tabId))
  }
  return { model: withWorkspace(model, command.workspace, next), closed, missing, refused }
}
