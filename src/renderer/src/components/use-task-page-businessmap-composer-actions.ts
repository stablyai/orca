import { useCallback } from 'react'
import { toast } from 'sonner'
import type { TaskPageBusinessmapListEffectsModel } from './use-task-page-businessmap-list-effects'
import type { BusinessmapCard } from '../../../shared/businessmap-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { translate } from '@/i18n/i18n'
import { buildBusinessmapWorkspaceSource } from '../../../shared/new-workspace/workspace-source'
import { bindTaskPageBusinessmapItemSourceContext } from './task-page-businessmap-item-source-context'
import { getBusinessmapCardWorkspaceSeed } from './task-page-source-context'

export function useTaskPageBusinessmapComposerActions({
  businessmapSites,
  businessmapTaskSourceContext,
  selectedBusinessmapSiteId,
  openModal
}: Pick<
  TaskPageBusinessmapListEffectsModel,
  'businessmapSites' | 'businessmapTaskSourceContext' | 'selectedBusinessmapSiteId' | 'openModal'
>) {
  const openComposerForBusinessmapItem = useCallback(
    (card: BusinessmapCard): void => {
      const taskSourceContext = bindTaskPageBusinessmapItemSourceContext({
        card,
        sites: businessmapSites,
        sourceContext: businessmapTaskSourceContext,
        selectedSiteId: selectedBusinessmapSiteId
      })
      if (!taskSourceContext) {
        toast.error(
          translate(
            'auto.components.TaskPage.businessmapLinkSourceUnavailable',
            'Couldn’t link this Businessmap card. Reconnect Businessmap, then try again.'
          )
        )
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = buildBusinessmapWorkspaceSource(card)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getBusinessmapCardWorkspaceSeed(card),
        telemetrySource: 'sidebar'
      })
    },
    [businessmapSites, businessmapTaskSourceContext, selectedBusinessmapSiteId, openModal]
  )
  const handleUseBusinessmapItem = useCallback(
    (card: BusinessmapCard): void => {
      openComposerForBusinessmapItem(card)
    },
    [openComposerForBusinessmapItem]
  )
  return { openComposerForBusinessmapItem, handleUseBusinessmapItem }
}
