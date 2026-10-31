import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { useImmediateMutation } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageGitHubCloseUpdate,
  type TaskPageGitHubCloseAction
} from '@/components/task-page/github/task-page-github-status-actions'
import { beginEdit } from './gh-edit-task-record'
import type { TaskDelta } from '@/store/github/task-record-cache'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubPatchWorkItemOptions } from '@/store/github/cache-model'
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
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onStateChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  itemId: GitHubWorkItem['id']
  newState: 'open' | 'closed'
  closeAction?: TaskPageGitHubCloseAction
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  patchWorkItem: (
    id: string,
    patch: { state: GitHubWorkItem['state'] },
    repoId: string | undefined,
    options: GitHubPatchWorkItemOptions
  ) => void
}): void {
  // Why: a close reason still has to reach GitHub even when the item already reads as closed locally.
  if (newState === localState && !closeAction) {
    return
  }
  let settle: (success: boolean) => GitHubWorkItem | null = () => item
  const patchState = (state: GitHubWorkItem['state']) =>
    patchWorkItem(itemId, { state }, itemRepoId, {
      sourceContext,
      ownerRepo: projectOrigin ?? issueRepo
    })
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
      settle = beginEdit(item, sourceContext, (base) => ({ ...base, state: newState }))
      onStateChange(newState)
      patchState(newState)
      patchProjectRowIfNeeded({ state: newState })
    },
    onRevert: () => {
      const current = settle(false)
      if (!current) {
        return
      }
      onStateChange(current.state)
      patchState(current.state)
      patchProjectRowIfNeeded({ state: current.state })
    },
    onSuccess: () => {
      const current = settle(true)
      if (!current) {
        return
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      patchState(current.state)
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
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  issueRepo,
  run,
  onLabelsChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  itemId: GitHubWorkItem['id']
  label: string
  localLabels: string[]
  onLabelsChange: (labels: string[]) => void
  patchWorkItem: (
    id: string,
    patch: { labels: string[] },
    repoId: string | undefined,
    options: GitHubPatchWorkItemOptions
  ) => void
}): void {
  const isAdding = !localLabels.includes(label)
  let settle: (success: boolean) => GitHubWorkItem | null = () => item
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
      settle = beginEdit(item, sourceContext, (base) => ({
        ...base,
        labels: isAdding
          ? [...new Set([...base.labels, label])]
          : base.labels.filter((value) => value !== label)
      }))
      onLabelsChange(newLabels)
      patchWorkItem(itemId, { labels: newLabels }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
      patchProjectRowIfNeeded({ labels: newLabels })
    },
    onRevert: () => {
      const current = settle(false)
      if (!current) {
        return
      }
      onLabelsChange(current.labels)
      patchWorkItem(itemId, { labels: current.labels }, itemRepoId, {
        sourceContext,
        ownerRepo: projectOrigin ?? issueRepo
      })
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

  const delta: TaskDelta = (base) => {
    const current = base.assignees ?? []
    return {
      ...base,
      assignees: isAssigned
        ? current.filter((user) => user.login.toLowerCase() !== login.toLowerCase())
        : current.some((user) => user.login.toLowerCase() === login.toLowerCase())
          ? current
          : [...current, { login, name: null, avatarUrl: '' }]
    }
  }
  let settle: (success: boolean) => GitHubWorkItem | null = () => item
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
        delta
      )
      setLocalAssignees(newAssignees)
      patchProjectRowIfNeeded({ assignees: newAssignees })
    },
    onRevert: () => {
      const accepted = settle(false)
      if (!accepted) {
        return
      }
      const current = accepted.assignees?.map((user) => user.login) ?? prevAssignees
      setLocalAssignees(current)
      patchProjectRowIfNeeded({ assignees: current })
    },
    onSuccess: () => {
      if (!settle(true)) {
        return
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}
