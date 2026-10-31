import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { useImmediateMutation } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageGitHubCloseUpdate,
  type TaskPageGitHubCloseAction
} from '@/components/task-page/github/task-page-github-status-actions'
import { beginEdit } from './gh-edit-task-record'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'

export type GHEditProjectRowPatch = {
  state?: GitHubWorkItem['state']
  labels?: string[]
  assignees?: string[]
}

export type GHEditMutationRun = ReturnType<typeof useImmediateMutation>['run']

type GHEditMutationBase = {
  item: GitHubWorkItem
  itemNumber: GitHubWorkItem['number']
  itemRepoId: GitHubWorkItem['repoId']
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  issueRepo?: GitHubOwnerRepo | null
  run: GHEditMutationRun
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
  onMutated: () => void
}

export function runGHEditStateChange({
  item,
  newState,
  closeAction,
  localState,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onStateChange,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  newState: 'open' | 'closed'
  closeAction?: TaskPageGitHubCloseAction
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
}): void {
  // Why: a close reason still has to reach GitHub even when the item already reads as closed locally.
  if (newState === localState && !closeAction) {
    return
  }
  // The record publishes Tasks copies; the dialog patches only its own state and Project origin row.
  let settle: (success: boolean) => GitHubWorkItem = () => item
  void run('state', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates:
          newState === 'closed' && closeAction
            ? buildTaskPageGitHubCloseUpdate(closeAction)
            : { state: newState }
      }),
    onOptimistic: () => {
      // Rollback restores what this dialog showed, as main's prevState did.
      settle = beginEdit({ ...item, state: localState }, sourceContext, { state: newState })
      onStateChange(newState)
      patchProjectRowIfNeeded({ state: newState })
    },
    onRevert: () => {
      const current = settle(false)
      onStateChange(current.state)
      patchProjectRowIfNeeded({ state: current.state })
    },
    onSuccess: () => {
      const current = settle(true)
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      patchProjectRowIfNeeded({ state: current.state })
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export { closeGHEditAsDuplicate } from './gh-edit-close-as-duplicate'

export function runGHEditLabelToggle({
  item,
  label,
  localLabels,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onLabelsChange,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  label: string
  localLabels: string[]
  onLabelsChange: (labels: string[]) => void
}): void {
  const isAdding = !localLabels.includes(label)
  let settle: (success: boolean) => GitHubWorkItem = () => item
  const prevLabels = localLabels
  const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

  void run('labels', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates: isAdding ? { addLabels: [label] } : { removeLabels: [label] }
      }),
    onOptimistic: () => {
      settle = beginEdit({ ...item, labels: localLabels }, sourceContext, {
        labels: { [label]: isAdding }
      })
      onLabelsChange(newLabels)
      patchProjectRowIfNeeded({ labels: newLabels })
    },
    onRevert: () => {
      const current = settle(false)
      onLabelsChange(current.labels)
      patchProjectRowIfNeeded({ labels: current.labels })
    },
    onSuccess: () => {
      settle(true)
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function runGHEditAssigneeToggle({
  item,
  login,
  localAssignees,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  setLocalAssignees,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  login: string
  localAssignees: string[]
  setLocalAssignees: (value: string[]) => void
}): void {
  const isAssigned = localAssignees.includes(login)
  const prevAssignees = localAssignees
  const newAssignees = isAssigned
    ? prevAssignees.filter((l) => l !== login)
    : [...prevAssignees, login]

  const change = {
    assignees: { [login.toLowerCase()]: isAssigned ? null : { login, name: null, avatarUrl: '' } }
  }
  let settle: (success: boolean) => GitHubWorkItem = () => item
  void run('assignees', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        issueRepo,
        number: itemNumber,
        updates: isAssigned ? { removeAssignees: [login] } : { addAssignees: [login] }
      }),
    onOptimistic: () => {
      settle = beginEdit(
        {
          ...item,
          assignees: localAssignees.map(
            (login) =>
              item.assignees?.find((user) => user.login.toLowerCase() === login.toLowerCase()) ?? {
                login,
                name: null,
                avatarUrl: ''
              }
          )
        },
        sourceContext,
        change
      )
      setLocalAssignees(newAssignees)
      patchProjectRowIfNeeded({ assignees: newAssignees })
    },
    onRevert: () => {
      const accepted = settle(false)
      const current = accepted.assignees?.map((user) => user.login) ?? prevAssignees
      setLocalAssignees(current)
      patchProjectRowIfNeeded({ assignees: current })
    },
    onSuccess: () => {
      settle(true)
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}
