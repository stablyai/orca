import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { NewIssueDraftSlice } from '@/store/slices/new-issue-draft'

export function useTaskPageCreateGithubSubmit({
  newIssueTargetRepo,
  newIssueTitle,
  newIssueSubmitting,
  newIssueRuntimeTarget,
  newIssueSourceContext,
  newIssueBody,
  newIssueLabels,
  newIssueAssignees,
  setNewIssueSubmitting,
  setNewIssueOpen,
  setNewIssueTitle,
  setNewIssueDraft,
  setNewIssueBody,
  setNewIssueLabels,
  setNewIssueAssignees,
  clearNewIssueDraft,
  setTaskRefreshNonce,
  openGitHubDetailPage,
  setDialogWorkItem
}: {
  newIssueTargetRepo: Repo | null
  newIssueTitle: string
  newIssueSubmitting: boolean
  newIssueRuntimeTarget: { kind: 'environment'; environmentId: string } | null
  newIssueSourceContext: TaskSourceContext | null
  newIssueBody: string
  newIssueLabels: string[]
  newIssueAssignees: GitHubAssignableUser[]
  setNewIssueSubmitting: Dispatch<SetStateAction<boolean>>
  setNewIssueOpen: Dispatch<SetStateAction<boolean>>
  setNewIssueTitle: Dispatch<SetStateAction<string>>
  setNewIssueDraft: NewIssueDraftSlice['setNewIssueDraft']
  setNewIssueBody: Dispatch<SetStateAction<string>>
  setNewIssueLabels: Dispatch<SetStateAction<string[]>>
  setNewIssueAssignees: Dispatch<SetStateAction<GitHubAssignableUser[]>>
  clearNewIssueDraft: NewIssueDraftSlice['clearNewIssueDraft']
  setTaskRefreshNonce: Dispatch<SetStateAction<number>>
  openGitHubDetailPage: (item: GitHubWorkItem) => void
  setDialogWorkItem: (item: GitHubWorkItem) => void
}) {
  const handleCreateNewIssue = useCallback(async (): Promise<void> => {
    if (!newIssueTargetRepo) {
      return
    }
    const title = newIssueTitle.trim()
    if (!title || newIssueSubmitting) {
      return
    }
    setNewIssueSubmitting(true)
    try {
      const result = newIssueRuntimeTarget
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.createIssue>>>(
            newIssueRuntimeTarget,
            'github.createIssue',
            {
              repo:
                newIssueSourceContext?.provider === 'github'
                  ? (newIssueSourceContext.repoId ?? newIssueTargetRepo.id)
                  : newIssueTargetRepo.id,
              title,
              body: newIssueBody,
              labels: newIssueLabels,
              assignees: newIssueAssignees.map((assignee) => assignee.login)
            },
            // Why: oversized-body recovery can need two 30s writes after GitHub rejects the initial create.
            { timeoutMs: 65_000 }
          )
        : await window.api.gh.createIssue({
            repoPath: newIssueTargetRepo.path,
            repoId: newIssueTargetRepo.id,
            sourceContext: newIssueSourceContext,
            title,
            body: newIssueBody,
            labels: newIssueLabels,
            assignees: newIssueAssignees.map((assignee) => assignee.login)
          })
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
        return
      }
      const createdIssueToast = translate(
        'auto.components.TaskPage.3f9604efc7',
        'Opened issue #{{value0}}',
        { value0: result.number }
      )
      const createdIssueToastOptions = {
        action: result.url
          ? {
              label: translate('auto.components.TaskPage.9c57663908', 'View'),
              onClick: () => window.open(result.url, '_blank')
            }
          : undefined
      }
      if (result.bodySaveWarning) {
        toast.warning(createdIssueToast, {
          ...createdIssueToastOptions,
          description: result.bodySaveWarning
        })
      } else {
        toast.success(createdIssueToast, createdIssueToastOptions)
      }
      setNewIssueOpen(false)
      if (result.bodySaveWarning) {
        // Why: keep the unsaved body for recovery but clear the title so reopening can't one-click repeat the create.
        setNewIssueTitle('')
        setNewIssueDraft({ title: '' })
      } else {
        setNewIssueTitle('')
        setNewIssueBody('')
        setNewIssueLabels([])
        setNewIssueAssignees([])
        // Why: only a complete success discards the recovery draft; a partial body save keeps the text for recovery.
        clearNewIssueDraft()
      }
      // Why: bump the nonce so the list refetches and shows the new issue.
      setTaskRefreshNonce((current) => current + 1)

      if (!result.url) {
        // Why: create only validates the number, so the URL can come back empty. A stub that
        // can't link out shouldn't open a detail page — the refetched list surfaces the issue.
        return
      }

      // Why: auto-open the new issue with an optimistic stub for immediate content, then refine with the full workItem fetch.
      const stub: GitHubWorkItem = {
        id: `issue:${String(result.number)}`,
        repoId: newIssueTargetRepo.id,
        type: 'issue',
        number: result.number,
        title,
        state: 'open',
        url: result.url,
        labels: newIssueLabels,
        assignees: newIssueAssignees,
        updatedAt: new Date().toISOString(),
        author: null
      }
      openGitHubDetailPage(stub)
      const stubRepoId = newIssueTargetRepo.id
      const fullIssuePromise = newIssueRuntimeTarget
        ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.workItem>>>(
            newIssueRuntimeTarget,
            'github.workItem',
            {
              repo:
                newIssueSourceContext?.provider === 'github'
                  ? (newIssueSourceContext.repoId ?? newIssueTargetRepo.id)
                  : newIssueTargetRepo.id,
              number: result.number,
              type: 'issue'
            },
            { timeoutMs: 30_000 }
          )
        : window.api.gh.workItem({
            repoPath: newIssueTargetRepo.path,
            repoId: newIssueTargetRepo.id,
            sourceContext: newIssueSourceContext,
            number: result.number,
            type: 'issue'
          })
      void fullIssuePromise
        .then((full) => {
          if (full) {
            // Why: cast through unknown — spreading the discriminated union loses the discriminant, so { ...full, repoId } won't typecheck.
            const withRepoId = { ...full, repoId: stubRepoId } as unknown as GitHubWorkItem
            setDialogWorkItem(withRepoId)
          }
        })
        .catch(() => {})
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
      )
    } finally {
      setNewIssueSubmitting(false)
    }
  }, [
    newIssueBody,
    newIssueAssignees,
    newIssueLabels,
    newIssueRuntimeTarget,
    newIssueSourceContext,
    newIssueSubmitting,
    newIssueTargetRepo,
    newIssueTitle,
    openGitHubDetailPage,
    setDialogWorkItem,
    clearNewIssueDraft,
    setNewIssueDraft,

    setNewIssueSubmitting,
    setNewIssueBody,
    setTaskRefreshNonce,
    setNewIssueOpen,
    setNewIssueAssignees,
    setNewIssueTitle,
    setNewIssueLabels
  ])

  return { handleCreateNewIssue }
}
