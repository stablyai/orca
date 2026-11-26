import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { findNgitItemWorkspace } from './ngit-item-workspace'
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
export function useNgitWorkspaceStart(repos: readonly Repo[]): {
  /** Resumes the item's workspace, or starts one. */
  openOrStart: (item: NgitWorkItem) => void
  /** Always a new workspace. */
  start: (item: NgitWorkItem) => void
} {
  const openModal = useAppStore((state) => state.openModal)
  const pendingRef = useRef<string | null>(null)
  const start = useCallback(
    (item: NgitWorkItem) => {
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
  const openOrStart = useCallback(
    (item: NgitWorkItem) => {
      const attached = findNgitItemWorkspace(
        useAppStore.getState().allWorktrees(),
        getWorkItemRepo(repos, item),
        item
      )
      if (!attached) {
        start(item)
        return
      }
      if (activateAndRevealWorktree(attached.id, { navigationIntent: 'user-open' }) === false) {
        toast.error(
          translate('components.taskPage.ngit.openWorkspaceFailed', 'Unable to open the workspace.')
        )
      }
    },
    [repos, start]
  )
  return { openOrStart, start }
}
