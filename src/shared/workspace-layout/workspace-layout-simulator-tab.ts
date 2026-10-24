// A simulator (mobile emulator) tab a window drew: main records it under the window's ids. The
// emulator itself is the window's; the layout holds only the tab.

import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { drawnTabOpen, withSendersGroup } from './workspace-layout-content-commands'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { placeContentTab } from './workspace-layout-tab-commands'

/** The same open again changes nothing; an id another tab holds, or a group main lacks, refuses. */
export function openSimulatorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openSimulatorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const kind = command.kind ?? 'simulator'
  // Only a layout-owner window sends this command, so a taken id is always refused.
  const drawn = drawnTabOpen(model, key, command.tabId, (tab) => tab.kind === kind, true)
  if (drawn) {
    return drawn
  }
  const workspace = model.workspaces[key]
  if (
    command.groupId &&
    workspace?.groups.length &&
    !workspace.groups.some((entry) => entry.id === command.groupId)
  ) {
    // Another group would put the tab where the window did not.
    return refuse('group_not_found')
  }
  const tab = {
    id: command.tabId,
    entityId: command.tabId,
    kind,
    createdAt: command.createdAt ?? context.now(),
    customTitle: null,
    color: null
  }
  const target = withSendersGroup(model, key, command.groupId)
  return applied(placeContentTab(target, key, tab, command, context).model, { tabId: tab.id })
}
