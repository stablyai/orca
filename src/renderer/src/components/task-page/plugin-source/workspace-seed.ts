import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'

/** Seeds a workspace from a contributed task item through the same
 *  `new-workspace-composer` modal every built-in provider opens.
 *
 *  It attaches no `linkedWorkItem`: that summary's provider is a closed union
 *  with no member for a contributed source, and widening it would force every
 *  exhaustive provider switch to handle an unknown provider. */
export function usePluginTaskItemWorkspaceSeed(): (item: PluginTaskItem) => void {
  const openModal = useAppStore((state) => state.openModal)
  return useCallback(
    (item: PluginTaskItem): void => {
      openModal('new-workspace-composer', {
        prefilledName: getLinkedWorkItemSuggestedName({ title: `${item.key} ${item.title}` }),
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )
}
