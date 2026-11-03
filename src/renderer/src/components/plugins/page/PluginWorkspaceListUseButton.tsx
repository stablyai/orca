import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginWorkspaceLists } from '@/store/plugin-workspace-lists'
import { getListSectionKey } from '../../../../../shared/sidebar-list/arranged-groups'

/** Arranges the workspace list with this plugin's sections, or goes back to Orca's grouping. */
export function PluginWorkspaceListUseButton({ listId }: { listId: string }): React.JSX.Element {
  const inUse = useAppStore((state) => state.settings?.workspaceListId === listId)
  const lists = usePluginWorkspaceLists()
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => pickWorkspaceList(inUse ? null : listId, lists)}
    >
      {inUse
        ? translate('auto.components.plugins.workspaceList.useOrca', "Use Orca's grouping")
        : translate('auto.components.plugins.workspaceList.use', 'Use for the list')}
    </Button>
  )
}

/** Picks a list arrangement; its default-collapsed sections start collapsed once, then the
 *  person's own toggles rule. */
export function pickWorkspaceList(
  listId: string | null,
  lists: ReturnType<typeof usePluginWorkspaceLists>
): void {
  const state = useAppStore.getState()
  void state.updateSettings({ workspaceListId: listId ?? undefined })
  const entry = listId ? lists.find((candidate) => candidate.id === listId) : undefined
  for (const section of entry?.arrangement.sections ?? []) {
    const key = getListSectionKey(entry!.id, section.id)
    if (section.collapsed && !useAppStore.getState().collapsedGroups.has(key)) {
      useAppStore.getState().toggleCollapsedGroup(key)
    }
  }
}
