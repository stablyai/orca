import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { useImmediateMutation } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page-github-status-actions'
import {
  assertTaskPageGitHubDialogAssigneesAuthority,
  assertTaskPageGitHubDialogStateAuthority,
  resolveTaskPageGitHubDialogAssigneeUsers
} from '@/components/task-page-github-dialog-state-authority'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'

export type GHEditProjectRowPatch = {
  state?: GitHubWorkItem['state']
  labels?: string[]
  assignees?: string[]
}

export type GHEditMutationRun = ReturnType<typeof useImmediateMutation>['run']

type GHEditMutationBase = {
  itemNumber: GitHubWorkItem['number']
  itemRepoId: GitHubWorkItem['repoId']
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  run: GHEditMutationRun
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
  onMutated: () => void
}

export function runGHEditStateChange({
  newState,
  closeAction,
  localState,
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
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
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
}): void {
  // Why: a close reason still has to reach GitHub even when the item already reads as closed locally.
  if (newState === localState && !closeAction) {
    return
  }
  const prevState = localState
  // Why: without registry authority a search-lagged Tasks refetch silently
  // reverts this row to its pre-mutation state (STA-3343).
  let authority: { revert: () => boolean } | null = null
  void run('state', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: itemNumber,
        updates:
          newState === 'closed' && closeAction
            ? buildTaskPageGitHubCloseUpdate(closeAction)
            : { state: newState }
      }),
    onOptimistic: () => {
      authority = assertTaskPageGitHubDialogStateAuthority({
        repoId: itemRepoId,
        itemId,
        state: newState,
        sourceContext
      })
      onStateChange(newState)
      patchWorkItem(itemId, { state: newState }, itemRepoId, { sourceContext })
      patchProjectRowIfNeeded({ state: newState })
    },
    onRevert: () => {
      if (authority?.revert()) {
        onStateChange(prevState)
        patchWorkItem(itemId, { state: prevState }, itemRepoId, { sourceContext })
        patchProjectRowIfNeeded({ state: prevState })
      }
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      patchWorkItem(itemId, { state: newState }, itemRepoId, { sourceContext })
      patchProjectRowIfNeeded({ state: newState })
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function closeGHEditAsDuplicate({
  targetIssueNumber,
  itemNumber,
  setDuplicateError,
  handleStateChange,
  setStatusPopoverOpen,
  setDuplicatePickerOpen
}: {
  targetIssueNumber: number | string
  itemNumber: number
  setDuplicateError: (value: string | null) => void
  handleStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  setStatusPopoverOpen: (value: boolean) => void
  setDuplicatePickerOpen: (value: boolean) => void
}): void {
  const validation = validateTaskPageGitHubDuplicateTarget(String(targetIssueNumber), itemNumber)
  if (!validation.ok) {
    setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
    return
  }
  setDuplicateError(null)
  handleStateChange('closed', { stateReason: 'duplicate', duplicateOf: validation.duplicateOf })
  setStatusPopoverOpen(false)
  setDuplicatePickerOpen(false)
}

export function runGHEditLabelToggle({
  label,
  localLabels,
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
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
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
}): void {
  const isAdding = !localLabels.includes(label)
  const prevLabels = localLabels
  const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

  if (isAdding) {
    void run('labels', {
      mutate: () =>
        runIssueUpdate({
          repoId: itemRepoId,
          repoPath,
          sourceContext,
          projectOrigin,
          number: itemNumber,
          updates: { addLabels: [label] }
        }),
      onOptimistic: () => {
        onLabelsChange(newLabels)
        patchWorkItem(itemId, { labels: newLabels }, itemRepoId, { sourceContext })
        patchProjectRowIfNeeded({ labels: newLabels })
      },
      onSuccess: () => {
        useAppStore.getState().recordFeatureInteraction('github-tasks')
        onMutated()
      },
      onRevert: () => {
        onLabelsChange(prevLabels)
        patchWorkItem(itemId, { labels: prevLabels }, itemRepoId, { sourceContext })
        patchProjectRowIfNeeded({ labels: prevLabels })
      },
      onError: (err) => toast.error(err)
    })
    return
  }
  void run('labels', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: itemNumber,
        updates: { removeLabels: [label] }
      }),
    onOptimistic: () => {
      onLabelsChange(newLabels)
      patchWorkItem(itemId, { labels: newLabels }, itemRepoId, { sourceContext })
      patchProjectRowIfNeeded({ labels: newLabels })
    },
    onRevert: () => {
      onLabelsChange(prevLabels)
      patchWorkItem(itemId, { labels: prevLabels }, itemRepoId, { sourceContext })
      patchProjectRowIfNeeded({ labels: prevLabels })
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function runGHEditAssigneeToggle({
  login,
  localAssignees,
  knownAssignees,
  assigneesItemKey,
  editedAssigneesItemKeyRef,
  itemId,
  itemNumber,
  itemRepoId,
  repoPath,
  sourceContext,
  projectOrigin,
  run,
  setLocalAssignees,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  itemId: GitHubWorkItem['id']
  login: string
  localAssignees: string[]
  knownAssignees: readonly GitHubAssignableUser[]
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  setLocalAssignees: (value: string[]) => void
  patchWorkItem: (
    id: string,
    patch: { assignees: GitHubAssignableUser[] },
    repoId: string | undefined,
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
}): void {
  const isAssigned = localAssignees.includes(login)
  const prevAssignees = localAssignees
  const newAssignees = isAssigned
    ? prevAssignees.filter((l) => l !== login)
    : [...prevAssignees, login]
  const prevUsers = resolveTaskPageGitHubDialogAssigneeUsers(prevAssignees, knownAssignees)
  const newUsers = resolveTaskPageGitHubDialogAssigneeUsers(newAssignees, knownAssignees)

  // Why: scope the optimistic guard to this repo item so switching items doesn't suppress the next item's assignee sync.
  editedAssigneesItemKeyRef.current = assigneesItemKey
  // Why: without registry authority a search-lagged Tasks refetch shows stale assignees (STA-3343).
  let authority: { revert: () => boolean } | null = null
  void run('assignees', {
    mutate: () =>
      runIssueUpdate({
        repoId: itemRepoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: itemNumber,
        updates: isAssigned ? { removeAssignees: [login] } : { addAssignees: [login] }
      }),
    onOptimistic: () => {
      authority = assertTaskPageGitHubDialogAssigneesAuthority({
        repoId: itemRepoId,
        itemId,
        assignees: newUsers,
        sourceContext
      })
      setLocalAssignees(newAssignees)
      patchWorkItem(itemId, { assignees: newUsers }, itemRepoId, { sourceContext })
      patchProjectRowIfNeeded({ assignees: newAssignees })
    },
    onRevert: () => {
      // Why: leaving the guard set after a failed toggle suppresses assignee prop syncs indefinitely.
      editedAssigneesItemKeyRef.current = null
      // Why: a newer owner (task-page mutation or quiet adopt) already holds every assignee
      // surface, so rolling back only some of them would split the dialog from the Tasks row.
      if (authority?.revert()) {
        setLocalAssignees(prevAssignees)
        patchWorkItem(itemId, { assignees: prevUsers }, itemRepoId, { sourceContext })
        patchProjectRowIfNeeded({ assignees: prevAssignees })
      }
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}
