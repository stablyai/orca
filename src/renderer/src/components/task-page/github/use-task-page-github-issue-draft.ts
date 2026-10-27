import type { TaskPageGitHubCacheReconciliationModel } from './use-task-page-github-cache-reconciliation'
import { useState, useMemo, useEffect } from 'react'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { useAppStore } from '@/store/index'
import { getGitHubRepoRoutingTarget } from '@/lib/github-source-runtime-context'
import { useRepoLabels, useRepoAssignees } from '@/hooks/useGitHubRepoMetadata'
import {
  resolveVanishedNewIssueRepoReset,
  isNewIssueDraftContentful
} from '@/components/task-page/task-page-new-issue-draft'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
export function useTaskPageGitHubIssueDraft(model: TaskPageGitHubCacheReconciliationModel) {
  const { settings, repos, selectedRepos } = model
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueBody, setNewIssueBody] = useState('')
  const [newIssueLabels, setNewIssueLabels] = useState<string[]>([])
  const [newIssueAssignees, setNewIssueAssignees] = useState<GitHubAssignableUser[]>([])
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false)
  const [newIssueRepoId, setNewIssueRepoId] = useState<string | null>(null)
  // Read the session draft imperatively so per-keystroke recovery writes cannot rerender all of Tasks.
  const setNewIssueDraft = useAppStore((s) => s.setNewIssueDraft)
  const clearNewIssueDraft = useAppStore((s) => s.clearNewIssueDraft)

  // Why: fall back to the first selected repo if the chosen id drops from the selection mid-dialog, so submit always has a valid target.
  const newIssueTargetRepo = useMemo(
    () => selectedRepos.find((r) => r.id === newIssueRepoId) ?? selectedRepos[0] ?? null,
    [selectedRepos, newIssueRepoId]
  )
  const newIssueSourceContext = useMemo(
    () => getTaskPageRepoSourceContext(newIssueTargetRepo, 'github'),
    [newIssueTargetRepo]
  )
  const newIssueRuntimeTarget = useMemo(() => {
    if (!newIssueTargetRepo?.id) {
      return null
    }
    const target = getGitHubRepoRoutingTarget(
      { repos: [newIssueTargetRepo], settings },
      newIssueTargetRepo.id,
      newIssueSourceContext
    )
    if (target.kind !== 'environment') {
      return null
    }
    return repos.some((repo) => repo.id === newIssueTargetRepo.id) ? target : null
  }, [newIssueSourceContext, newIssueTargetRepo, repos, settings])
  const newIssueRepoLabels = useRepoLabels(
    newIssueOpen ? (newIssueTargetRepo?.path ?? null) : null,
    newIssueOpen ? (newIssueTargetRepo?.id ?? null) : null,
    { target: newIssueOpen ? newIssueRuntimeTarget : null }
  )
  const newIssueRepoAssignees = useRepoAssignees(
    newIssueOpen ? (newIssueTargetRepo?.path ?? null) : null,
    newIssueOpen ? (newIssueTargetRepo?.id ?? null) : null,
    { target: newIssueOpen ? newIssueRuntimeTarget : null }
  )

  // Clear only vanished repo targets; reacting to every target change would also wipe restored drafts.
  useEffect(() => {
    const reset = resolveVanishedNewIssueRepoReset(
      newIssueRepoId,
      selectedRepos.map((r) => r.id)
    )
    if (!reset) {
      return
    }
    setNewIssueLabels([])
    setNewIssueAssignees([])
    setNewIssueRepoId(reset.repoId)
  }, [newIssueRepoId, selectedRepos])

  // Persist only contentful open drafts so dismissal preserves input without pinning an untouched form.
  useEffect(() => {
    if (!newIssueOpen) {
      return
    }
    if (
      isNewIssueDraftContentful({
        title: newIssueTitle,
        body: newIssueBody,
        labels: newIssueLabels,
        assignees: newIssueAssignees
      })
    ) {
      setNewIssueDraft({
        title: newIssueTitle,
        body: newIssueBody,
        labels: newIssueLabels,
        assignees: newIssueAssignees,
        repoId: newIssueRepoId
      })
    } else {
      clearNewIssueDraft()
    }
  }, [
    newIssueOpen,
    newIssueTitle,
    newIssueBody,
    newIssueLabels,
    newIssueAssignees,
    newIssueRepoId,
    setNewIssueDraft,
    clearNewIssueDraft
  ])
  const nextModel = model as typeof model & {
    newIssueOpen: typeof newIssueOpen
    setNewIssueOpen: typeof setNewIssueOpen
    newIssueTitle: typeof newIssueTitle
    setNewIssueTitle: typeof setNewIssueTitle
    newIssueBody: typeof newIssueBody
    setNewIssueBody: typeof setNewIssueBody
    newIssueLabels: typeof newIssueLabels
    setNewIssueLabels: typeof setNewIssueLabels
    newIssueAssignees: typeof newIssueAssignees
    setNewIssueAssignees: typeof setNewIssueAssignees
    newIssueSubmitting: typeof newIssueSubmitting
    setNewIssueSubmitting: typeof setNewIssueSubmitting
    newIssueRepoId: typeof newIssueRepoId
    setNewIssueRepoId: typeof setNewIssueRepoId
    setNewIssueDraft: typeof setNewIssueDraft
    clearNewIssueDraft: typeof clearNewIssueDraft
    newIssueTargetRepo: typeof newIssueTargetRepo
    newIssueSourceContext: typeof newIssueSourceContext
    newIssueRuntimeTarget: typeof newIssueRuntimeTarget
    newIssueRepoLabels: typeof newIssueRepoLabels
    newIssueRepoAssignees: typeof newIssueRepoAssignees
  }
  nextModel.newIssueOpen = newIssueOpen
  nextModel.setNewIssueOpen = setNewIssueOpen
  nextModel.newIssueTitle = newIssueTitle
  nextModel.setNewIssueTitle = setNewIssueTitle
  nextModel.newIssueBody = newIssueBody
  nextModel.setNewIssueBody = setNewIssueBody
  nextModel.newIssueLabels = newIssueLabels
  nextModel.setNewIssueLabels = setNewIssueLabels
  nextModel.newIssueAssignees = newIssueAssignees
  nextModel.setNewIssueAssignees = setNewIssueAssignees
  nextModel.newIssueSubmitting = newIssueSubmitting
  nextModel.setNewIssueSubmitting = setNewIssueSubmitting
  nextModel.newIssueRepoId = newIssueRepoId
  nextModel.setNewIssueRepoId = setNewIssueRepoId
  nextModel.setNewIssueDraft = setNewIssueDraft
  nextModel.clearNewIssueDraft = clearNewIssueDraft
  nextModel.newIssueTargetRepo = newIssueTargetRepo
  nextModel.newIssueSourceContext = newIssueSourceContext
  nextModel.newIssueRuntimeTarget = newIssueRuntimeTarget
  nextModel.newIssueRepoLabels = newIssueRepoLabels
  nextModel.newIssueRepoAssignees = newIssueRepoAssignees
  return nextModel
}
export type TaskPageGitHubIssueDraftModel = ReturnType<typeof useTaskPageGitHubIssueDraft>
