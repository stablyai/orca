import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import { getWorkItemRepo } from '@/lib/work-items/work-item-repo-row'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { getLinkedWorkItemSuggestedName } from '../../../../../shared/workspace/naming/workspace-name'

/** Opens the workspace composer for an issue, or for a pull request at its fetched tip. */
export function useNgitWorkspaceStart(repos: readonly Repo[]): (item: NgitWorkItem) => void {
  const openModal = useAppStore((state) => state.openModal)
  const pendingRef = useRef<string | null>(null)
  return useCallback(
    (item) => {
      const repo = getWorkItemRepo(repos, item)
      if (!repo || pendingRef.current === item.id) {
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        provider: 'ngit',
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url,
        repoId: item.repoId
      }
      const open = (prefilledName: string, initialBaseBranch?: string): void =>
        openModal('new-workspace-composer', {
          linkedWorkItem,
          taskSourceContext: getTaskPageRepoSourceContext(repo, 'ngit'),
          prefilledName,
          initialRepoId: item.repoId,
          ...(initialBaseBranch ? { initialBaseBranch } : {}),
          telemetrySource: 'sidebar'
        })
      if (item.type === 'issue') {
        open(getLinkedWorkItemSuggestedName(item))
        return
      }
      pendingRef.current = item.id
      const progress = toast.loading(
        translate('components.taskPage.ngit.fetchingPr', 'Fetching the pull request…')
      )
      ngitApiFor(repo)
        .resolvePrBase(item.eventId)
        .then((result) => {
          if (result.ok) {
            open(result.workspaceName, result.baseBranch)
          } else {
            toast.error(result.error)
          }
        })
        .catch((error) => toast.error(readIpcErrorDetail(error) ?? String(error)))
        .finally(() => {
          toast.dismiss(progress)
          pendingRef.current = null
        })
    },
    [openModal, repos]
  )
}
