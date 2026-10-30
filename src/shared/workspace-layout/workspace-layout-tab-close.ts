import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import { filterRecord, withoutKey } from './stored-record-fields'
import { editorTabShowsFile, keptAfterEditorClose } from './workspace-layout-editor-tab-file'
import { applied, findTab, leafIdsOf, type Applied } from './workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutCommandResult,
  LayoutEffects
} from './workspace-layout-command-types'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { removeTabFromWorkspace, withWorkspace } from './workspace-layout-removal'

/** Removes a tab and its content record; a terminal tab's pane data goes with it. */
export function closeTab(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string
): WorkspaceLayoutModel {
  const workspace = model.workspaces[key]!
  const tab = findTab(workspace, tabId)!
  let next: WorkspaceLayout = removeTabFromWorkspace(workspace, tabId)
  if (tab.kind === 'terminal' && next.leaves) {
    const leafIds = leafIdsOf(tab)
    next = { ...next, leaves: filterRecord(next.leaves, (leafId) => !leafIds.includes(leafId)) }
  }
  if (
    tab.kind === 'editor' &&
    next.editorFiles &&
    !next.tabs.some((entry) => entry.entityId === tab.entityId)
  ) {
    next = {
      ...next,
      editorFiles: next.editorFiles.filter(
        // Why the switch: shipped builds close through this code too.
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? keptAfterEditorClose(workspace, next, tab.entityId)
          : (file) => !editorTabShowsFile(tab.entityId, file, next.worktreeId)
      )
    }
  }
  if (next.editorViews) {
    next = { ...next, editorViews: withoutKey(next.editorViews, tabId) }
  }
  if (tab.kind === 'browser' && next.browserTabs) {
    next = { ...next, browserTabs: next.browserTabs.filter((entry) => entry.id !== tab.entityId) }
  }
  return withWorkspace(model, key, next)
}

/** After the new tab is placed: the replaced tab leaves in the same write, when it is still there. */
export function closeReplacedTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'createTerminalTab' | 'openAgentSessionTab'>,
  result: LayoutCommandResult,
  effects?: Partial<LayoutEffects>
): Applied {
  const replaced = command.replaces?.tabId
  const workspace = model.workspaces[command.workspace]
  if (!replaced || !workspace || !findTab(workspace, replaced)) {
    return applied(model, result, effects)
  }
  return applied(
    closeTab(model, command.workspace, replaced),
    { ...result, closed: [replaced] },
    effects
  )
}
