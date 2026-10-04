import { toast } from 'sonner'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import { resolveTaskPageGitHubDialogAssigneeUsers } from '@/components/task-page-github-dialog-state-authority'
import {
  beginTaskPageGitHubWorkItemMutation,
  canStartTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation,
  getRegistryMergedTaskPageGitHubWorkItem,
  rollbackTaskPageGitHubWorkItemMutation,
  type BeginTaskPageGitHubWorkItemMutationResult,
  type TaskPageGitHubPatchWorkItem
} from '@/components/task-page-github-work-item-mutations'
import {
  getConfirmedListSnapshot,
  listPendingTaskPageGitHubOpsForItem,
  subscribeTaskPageGitHubMutationRegistry
} from '@/components/task-page-github-work-item-mutation-registry'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import type { GHEditMutationRun, GHEditProjectRowPatch } from './gh-edit-section-mutations'

/** Keep dialog and Project rows on composed authority when a Tasks-row operation settles later. */
function subscribeGHEditAssignees(args: {
  item: GitHubWorkItem
  sourceContext?: TaskSourceContext | null
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  lastLoginsRef: { current: string | undefined }
  apply: (assignees: string[]) => void
}): () => void {
  const scope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const update = () => {
    const snapshot = getConfirmedListSnapshot(scope, args.item.repoId, args.item.id, 'assignees')
    const pending = listPendingTaskPageGitHubOpsForItem(args.item.repoId, args.item.id, scope)
    if (snapshot === undefined && !pending.some((op) => op.listOp?.family === 'assignees')) {
      if (args.editedAssigneesItemKeyRef.current === args.assigneesItemKey) {
        args.editedAssigneesItemKeyRef.current = null
      }
      args.lastLoginsRef.current = undefined
      return
    }
    args.editedAssigneesItemKeyRef.current = args.assigneesItemKey
    const assignees =
      getRegistryMergedTaskPageGitHubWorkItem(args.item, scope).assignees?.map(
        (user) => user.login
      ) ?? []
    const logins = JSON.stringify([scope, args.assigneesItemKey, assignees])
    if (logins !== args.lastLoginsRef.current) {
      args.lastLoginsRef.current = logins
      args.apply(assignees)
    }
  }
  const unsubscribe = subscribeTaskPageGitHubMutationRegistry(update)
  update()
  return unsubscribe
}

/** Subscribe while the dialog is mounted, including after its own request completes. */
export function useGHEditAssigneesAuthority(args: {
  item: GitHubWorkItem
  sourceContext?: TaskSourceContext | null
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  setLocalAssignees: (assignees: string[]) => void
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
}): void {
  const lastLoginsRef = useRef<string | undefined>(undefined)
  const {
    item,
    sourceContext,
    assigneesItemKey,
    editedAssigneesItemKeyRef,
    setLocalAssignees,
    patchProjectRowIfNeeded
  } = args
  useEffect(
    () =>
      subscribeGHEditAssignees({
        item,
        sourceContext,
        assigneesItemKey,
        editedAssigneesItemKeyRef,
        lastLoginsRef,
        apply: (assignees) => {
          setLocalAssignees(assignees)
          patchProjectRowIfNeeded({ assignees })
        }
      }),
    [
      item,
      sourceContext,
      assigneesItemKey,
      editedAssigneesItemKeyRef,
      setLocalAssignees,
      patchProjectRowIfNeeded
    ]
  )
}

/** Share per-login operations with Tasks rows so rollback removes only this dialog edit. */
export function runGHEditAssigneeToggle({
  item,
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
}: {
  itemNumber: GitHubWorkItem['number']
  itemRepoId: GitHubWorkItem['repoId']
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  run: GHEditMutationRun
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
  onMutated: () => void
  item: GitHubWorkItem
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
  const prevAssignees = localAssignees
  const prevUsers = resolveTaskPageGitHubDialogAssigneeUsers(prevAssignees, knownAssignees)
  const mutationItem = { ...item, assignees: prevUsers }
  const sourceScope =
    sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null
  const current = getRegistryMergedTaskPageGitHubWorkItem(mutationItem, sourceScope)
  const isAssigned =
    current.assignees?.some((assignee) => assignee.login.toLowerCase() === login.toLowerCase()) ??
    false
  const user = resolveTaskPageGitHubDialogAssigneeUsers([login], knownAssignees)[0]
  const input = {
    item: mutationItem,
    intent: { type: 'toggleAssignee' as const, user },
    sourceContext
  }
  if (!canStartTaskPageGitHubWorkItemMutation(input)) {
    return
  }
  const patchAssignees: TaskPageGitHubPatchWorkItem = (_id, patch) => {
    if (patch.assignees === undefined) {
      return
    }
    const assignees = patch.assignees.map((assignee) => assignee.login)
    setLocalAssignees(assignees)
    patchWorkItem(itemId, { assignees: patch.assignees }, itemRepoId, { sourceContext })
    patchProjectRowIfNeeded({ assignees })
  }

  // Why: scope the optimistic guard to this repo item so switching items doesn't suppress the next item's assignee sync.
  editedAssigneesItemKeyRef.current = assigneesItemKey
  let mutation: BeginTaskPageGitHubWorkItemMutationResult | null = null
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
      mutation = beginTaskPageGitHubWorkItemMutation({ ...input, patchWorkItem: patchAssignees })
    },
    onRevert: () => {
      // Why: leaving the guard set after a failed toggle suppresses assignee prop syncs indefinitely.
      editedAssigneesItemKeyRef.current = null
      if (mutation) {
        rollbackTaskPageGitHubWorkItemMutation({
          key: mutation.key,
          generation: mutation.generation,
          item: mutationItem,
          sourceContext,
          patchWorkItem: patchAssignees
        })
      }
    },
    onSuccess: () => {
      if (mutation) {
        confirmTaskPageGitHubWorkItemMutation(mutation.key, mutation.generation, {
          item: mutationItem,
          sourceContext,
          patchWorkItem: patchAssignees
        })
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}
