import { toast } from 'sonner'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PullRequestPageProjectOrigin } from '../page-types'

type IssueUpdateRun = (
  key: string,
  spec: {
    mutate: () => Promise<unknown>
    onOptimistic: () => void
    onRevert: () => void
    onSuccess: () => void
    onError: (err: string) => void
  }
) => void

export function changeIssueState(args: {
  newState: 'open' | 'closed'
  localState: GitHubWorkItem['state']
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  run: IssueUpdateRun
  onStateChange: (state: GitHubWorkItem['state']) => void
  patchWorkItem: (
    id: string,
    patch: Partial<GitHubWorkItem>,
    repoId?: string | null,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  patchProjectRowIfNeeded: (patch: { state: GitHubWorkItem['state'] }) => void
  onMutated: () => void
}): void {
  if (args.newState === args.localState) {
    return
  }
  const prevState = args.localState
  args.run('state', {
    mutate: () =>
      runIssueUpdate({
        repoId: args.item.repoId,
        repoPath: args.repoPath,
        sourceContext: args.sourceContext,
        projectOrigin: args.projectOrigin,
        number: args.item.number,
        updates: { state: args.newState }
      }),
    onOptimistic: () => {
      args.onStateChange(args.newState)
      args.patchWorkItem(args.item.id, { state: args.newState }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
      args.patchProjectRowIfNeeded({ state: args.newState })
    },
    onRevert: () => {
      args.onStateChange(prevState)
      args.patchWorkItem(args.item.id, { state: prevState }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
      args.patchProjectRowIfNeeded({ state: prevState })
    },
    onSuccess: () => {
      args.patchWorkItem(args.item.id, { state: args.newState }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
      args.patchProjectRowIfNeeded({ state: args.newState })
      args.onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function toggleIssueLabel(args: {
  label: string
  localLabels: string[]
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  run: IssueUpdateRun
  onLabelsChange: (labels: string[]) => void
  patchWorkItem: (
    id: string,
    patch: Partial<GitHubWorkItem>,
    repoId?: string | null,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  patchProjectRowIfNeeded: (patch: { labels: string[] }) => void
  onMutated: () => void
}): void {
  const isAdding = !args.localLabels.includes(args.label)
  const prevLabels = args.localLabels
  const newLabels = isAdding
    ? [...prevLabels, args.label]
    : prevLabels.filter((l) => l !== args.label)

  const applyLabels = (labels: string[]): void => {
    args.onLabelsChange(labels)
    args.patchWorkItem(args.item.id, { labels }, args.item.repoId, {
      sourceContext: args.sourceContext
    })
    args.patchProjectRowIfNeeded({ labels })
  }

  args.run('labels', {
    mutate: () =>
      runIssueUpdate({
        repoId: args.item.repoId,
        repoPath: args.repoPath,
        sourceContext: args.sourceContext,
        projectOrigin: args.projectOrigin,
        number: args.item.number,
        updates: isAdding ? { addLabels: [args.label] } : { removeLabels: [args.label] }
      }),
    onOptimistic: () => applyLabels(newLabels),
    onRevert: () => applyLabels(prevLabels),
    onSuccess: () => {
      args.onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function toggleIssueAssignee(args: {
  login: string
  localAssignees: string[]
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  run: IssueUpdateRun
  setLocalAssignees: (value: string[]) => void
  patchProjectRowIfNeeded: (patch: { assignees: string[] }) => void
  onMutated: () => void
}): void {
  const isAssigned = args.localAssignees.includes(args.login)
  const prevAssignees = args.localAssignees
  const newAssignees = isAssigned
    ? prevAssignees.filter((l) => l !== args.login)
    : [...prevAssignees, args.login]

  // Why: scope the optimistic guard to this repo item so switching items doesn't suppress the next item's assignee sync.
  args.editedAssigneesItemKeyRef.current = args.assigneesItemKey

  const applyAssignees = (assignees: string[]): void => {
    args.setLocalAssignees(assignees)
    args.patchProjectRowIfNeeded({ assignees })
  }

  args.run('assignees', {
    mutate: () =>
      runIssueUpdate({
        repoId: args.item.repoId,
        repoPath: args.repoPath,
        sourceContext: args.sourceContext,
        projectOrigin: args.projectOrigin,
        number: args.item.number,
        updates: isAssigned ? { removeAssignees: [args.login] } : { addAssignees: [args.login] }
      }),
    onOptimistic: () => applyAssignees(newAssignees),
    onRevert: () => applyAssignees(prevAssignees),
    onSuccess: () => {
      args.onMutated()
    },
    onError: (err) => toast.error(err)
  })
}
