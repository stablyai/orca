import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import { buildPluginWorkspaceSource } from '../../../../../shared/new-workspace/workspace-source'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'

/** Seeds a workspace from a contributed task item through the same
 *  `new-workspace-composer` modal every built-in provider opens. */
export function usePluginTaskItemWorkspaceSeed(): (item: PluginTaskItem) => void {
  const openModal = useAppStore((state) => state.openModal)
  const selected = useAppStore((state) => state.selectedPluginTaskSource)
  return useCallback(
    (item: PluginTaskItem): void => {
      const url = item.url
      // A linked item without a url does not survive normalization, and a
      // source that gave none leaves nothing to link to. The seeded name still
      // carries the key, so the composer opens on the same text either way.
      const linkedWorkItem =
        url && selected
          ? buildPluginWorkspaceSource({
              key: item.key,
              title: item.title,
              url,
              pluginKey: selected.pluginKey,
              sourceId: selected.sourceId
            })
          : null
      openModal('new-workspace-composer', {
        ...(linkedWorkItem ? { linkedWorkItem } : {}),
        prefilledName: getLinkedWorkItemSuggestedName({ title: `${item.key} ${item.title}` }),
        telemetrySource: 'sidebar'
      })
    },
    [openModal, selected]
  )
}
