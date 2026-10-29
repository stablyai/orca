// Apply ordered default terminal tabs and their one-time mark in one write/frame.

import { applied, type Applied } from './workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutCommandResult,
  LayoutContext
} from './workspace-layout-command-types'
import { paneKeyOf, type WorkspaceLayoutModel } from './workspace-layout-model'
import { createTerminalTab } from './workspace-layout-tab-commands'

export function applyDefaultTabs(
  model: WorkspaceLayoutModel,
  command: CommandOf<'applyDefaultTabs'>,
  context: LayoutContext,
  mark: (model: WorkspaceLayoutModel, workspace: string) => Applied
): Applied {
  if (model.records.defaultTabsAppliedByWorkspace?.[command.workspace]) {
    return applied(model, { createdTabs: [] })
  }
  let next = model
  const createdTabs: NonNullable<LayoutCommandResult['createdTabs']> = []
  const startPaneKeys: string[] = []
  for (const template of command.tabs) {
    const { tabId, leafId } = template
    const created = createTerminalTab(
      next,
      {
        type: 'createTerminalTab',
        workspace: command.workspace,
        tabId,
        leafId,
        ...(template.title ? { title: template.title } : {}),
        ...(template.color ? { color: template.color } : {}),
        ...(template.creation ? { creation: template.creation } : {})
      },
      context
    )
    if (!created.ok) {
      return created
    }
    next = created.model
    createdTabs.push({ tabId, leafId, paneKey: paneKeyOf(tabId, leafId) })
    startPaneKeys.push(...created.effects.startPaneKeys)
  }
  const marked = mark(next, command.workspace)
  return marked.ok ? applied(marked.model, { createdTabs }, { startPaneKeys }) : marked
}
