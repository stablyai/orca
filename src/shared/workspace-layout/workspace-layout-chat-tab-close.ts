import { removeGroupLayoutLeaf } from './tab-group-layout-tree'
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
  // Where in the command each tab closed: emptied groups leave the tree in that order.
  const closedAt = new Map<string, number>()
  const closed: string[] = []
  const missing: string[] = []
  const refused: RefusedClose[] = []
  for (const [index, tabId] of command.tabIds.entries()) {
    const tab = closedAt.has(tabId) ? undefined : byId.get(tabId)
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
    closedAt.set(tabId, index)
    closed.push(tabId)
  }
  if (closedAt.size === 0) {
    return { model, closed, missing, refused }
  }
  const emptied: { groupId: string; at: number }[] = []
  const groups = workspace.groups.flatMap((group) => {
    let last = -1
    const tabOrder = group.tabOrder.filter((id) => {
      const at = closedAt.get(id)
      if (at === undefined) {
        return true
      }
      last = Math.max(last, at)
      return false
    })
    if (last < 0) {
      return [group]
    }
    if (tabOrder.length === 0) {
      emptied.push({ groupId: group.id, at: last })
      return []
    }
    return [{ ...group, tabOrder }]
  })
  let groupLayout = workspace.groupLayout
  for (const { groupId } of emptied.sort((a, b) => a.at - b.at)) {
    groupLayout = groupLayout
      ? (removeGroupLayoutLeaf(groupLayout, groupId) ?? undefined)
      : undefined
  }
  const next: WorkspaceLayout = {
    ...workspace,
    tabs: workspace.tabs.filter((tab) => !closedAt.has(tab.id)),
    groups
  }
  if (groupLayout) {
    next.groupLayout = groupLayout
  } else {
    delete next.groupLayout
  }
  if (next.editorViews) {
    next.editorViews = filterRecord(next.editorViews, (tabId) => !closedAt.has(tabId))
  }
  return { model: withWorkspace(model, command.workspace, next), closed, missing, refused }
}
