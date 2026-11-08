import { refreshGitStatusForWorktree } from '@/components/right-sidebar/source-control/sync/git-status-refresh'
import { switchRuntimeGitBranch } from '@/runtime/source-control/git/runtime-git-branch-client'
import type { BranchSwitchTarget } from '../../../../../shared/git/branch-switch-target'
import { createStore } from 'zustand/vanilla'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { gitGraphOwnerKey } from './git-graph-workspace-navigation'
import { gitCommitActionsSupported } from '@/runtime/source-control/git/git-commit-actions-capability'
import {
  createRuntimeGitBranch,
  cherryPickRuntimeGit,
  revertRuntimeGit
} from '@/runtime/source-control/git/runtime-git-commit-actions-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import type { GitGraphHistoryController } from './git-graph-history-controller'
import type {
  GitHistoryItem,
  GitHistoryItemRef
} from '../../../../../shared/git/history/git-history-types'
import type { GitCommitActionResult } from '../../../../../shared/git/commands/git-commit-action'
import {
  gitGraphActionOutcome,
  gitGraphActionMessage,
  type GitGraphCommitAction
} from './git-graph-commit-action-copy'

type PendingCommitAction = {
  action: GitGraphCommitAction
  branchTarget?: BranchSwitchTarget
  name?: string
  item: GitHistoryItem
  scope: NonNullable<ReturnType<typeof gitGraphScope>>
}
export class GitGraphCommitActionsController {
  readonly view = createStore<{ pending?: PendingCommitAction; running: boolean }>(() => ({
    running: false
  }))
  constructor(private readonly history: GitGraphHistoryController) {}
  cancel = () => {
    this.view.setState({ pending: undefined })
  }
  request = (
    action: GitGraphCommitAction,
    item: GitHistoryItem,
    branchTarget?: BranchSwitchTarget
  ) => {
    const scope = this.history.actionScope
    if (!scope || this.view.getState().running) {
      return
    }
    this.history.select(item.id)
    this.view.setState({ pending: { action, item, scope, branchTarget } })
  }
  requestBranch = (item: GitHistoryItem, ref: GitHistoryItemRef) => {
    const kind = ref.id.startsWith('refs/heads/')
      ? 'local'
      : ref.id.startsWith('refs/remotes/')
        ? 'remote'
        : null
    if (!kind) {
      return
    }
    this.request('checkout-branch', item, {
      kind,
      name: ref.id.slice(kind === 'local' ? 'refs/heads/'.length : 'refs/remotes/'.length)
    })
  }
  setBranchName = (name: string) => {
    const pending = this.view.getState().pending
    if (pending?.action === 'create-branch') {
      this.view.setState({ pending: { ...pending, name } })
    }
  }
  private owns(scope: PendingCommitAction['scope']): boolean {
    return (
      gitGraphOwnerKey(scope) ===
      gitGraphOwnerKey(
        gitGraphScope(
          this.history.worktreeId,
          useAppStore.getState(),
          scope.route.executionHostId ?? undefined
        )
      )
    )
  }
  confirm = async (): Promise<void> => {
    const pending = this.view.getState().pending
    if (!pending || this.view.getState().running) {
      return
    }
    const { scope, item, action } = pending
    const current = this.history.captureActionView()
    this.view.setState({ pending: undefined, running: true })
    const checkOwner = () => {
      if (!this.owns(scope)) {
        throw new Error(
          translate(
            'gitGraph.ownerChanged',
            'The workspace host changed. Reopen the Git Graph and try again.'
          )
        )
      }
    }
    let result: GitCommitActionResult
    try {
      if (!(await gitCommitActionsSupported(scope.target)) || !current() || !this.owns(scope)) {
        throw new Error(
          translate(
            'gitGraph.actionUnavailable',
            'This workspace is no longer available for the action. Reopen the Git Graph and try again.'
          )
        )
      }
      const context = {
        target: scope.target,
        worktreeId: this.history.worktreeId,
        worktreePath: scope.worktree.path,
        connectionId: scope.connectionId ?? undefined
      }
      if (action === 'checkout-branch' && pending.branchTarget) {
        const switched = await switchRuntimeGitBranch(
          context,
          pending.branchTarget,
          undefined,
          checkOwner
        )
        result = {
          outcome: switched.warning ? 'landed-with-warning' : 'landed',
          branch: switched.branch,
          commitId: switched.head,
          message: switched.warning
        }
      } else if (action === 'create-branch') {
        result = await createRuntimeGitBranch(context, pending.name ?? '', item.id, checkOwner)
      } else if (action === 'checkout') {
        await callRuntimeRpc(
          scope.target,
          'git.checkout',
          {
            worktree: toRuntimeWorktreeSelector(this.history.worktreeId),
            branch: item.id,
            detached: true
          },
          {
            timeoutMs: 30_000,
            beforeSend: checkOwner
          }
        )
        result = { outcome: 'landed', commitId: item.id }
      } else {
        result = await (action === 'cherry-pick' ? cherryPickRuntimeGit : revertRuntimeGit)(
          context,
          item.id,
          checkOwner
        )
      }
    } catch (error) {
      const data = error instanceof RuntimeRpcCallError ? error.response.error.data : undefined
      const landed =
        data !== null &&
        typeof data === 'object' &&
        'outcome' in data &&
        data.outcome === 'landed-with-warning'
      result = {
        outcome: landed ? 'landed-with-warning' : 'refused',
        ...(landed ? { commitId: item.id } : {}),
        message: error instanceof Error ? error.message : String(error)
      }
    }
    // Only the follow-up view is fenced; the user always hears what the confirmed action did.
    let outside = false
    if (this.owns(scope)) {
      const selectResult = current()
      const refreshing = this.history.refresh()
      const afterRefresh = this.history.captureActionView()
      const shouldApplyStatus = () =>
        useAppStore.getState().activeWorktreeId === this.history.worktreeId &&
        this.owns(scope) &&
        gitGraphOwnerKey(gitGraphScope(this.history.worktreeId)) === gitGraphOwnerKey(scope)
      const statusRefresh = shouldApplyStatus()
        ? refreshGitStatusForWorktree({
            target: scope.target,
            ownerHostId: scope.route.executionHostId,
            worktreeId: this.history.worktreeId,
            worktreePath: scope.worktree.path,
            connectionId: scope.connectionId ?? undefined,
            pushTarget: scope.worktree.pushTarget,
            deps: useAppStore.getState(),
            request: { shouldApply: shouldApplyStatus }
          }).catch(() => {})
        : undefined
      const [refreshed] = await Promise.all([refreshing, statusRefresh])
      if (selectResult && afterRefresh() && this.owns(scope) && result.commitId) {
        outside = !refreshed?.items.some((commit) => commit.id === result.commitId)
        if (!outside && this.owns(scope)) {
          this.history.select(result.commitId)
        }
      }
    }
    this.view.setState({ running: false })
    const description = [
      result.outcome === 'landed-with-warning'
        ? gitGraphActionOutcome({ ...result, outcome: 'landed' }, action)
        : '',
      result.outcome === 'empty' ? '' : gitGraphActionMessage(result)
    ]
      .filter(Boolean)
      .join('\n')
    toast.message(gitGraphActionOutcome(result, action), {
      description,
      ...(outside && result.commitId
        ? {
            action: {
              label: translate('gitGraph.showAllBranches', 'Show all branches'),
              onClick: () => {
                if (this.owns(scope) && this.history.captureActionView()()) {
                  void this.showAll(result, action)
                }
              }
            }
          }
        : {})
    })
  }
  private async showAll(
    outcome: GitCommitActionResult,
    action: GitGraphCommitAction
  ): Promise<void> {
    const commitId = outcome.commitId
    if (!commitId) {
      return
    }
    useAppStore.setState((state) => ({
      gitGraphFiltersByWorktree: {
        ...state.gitGraphFiltersByWorktree,
        [this.history.worktreeId]: 'all'
      }
    }))
    const refreshing = this.history.settledResult()
    const current = this.history.captureActionView()
    let result = await refreshing
    if (current() && !result?.items.some((item) => item.id === commitId) && result?.hasMore) {
      result = await this.history.loadMore()
    }
    if (current() && result?.items.some((item) => item.id === commitId)) {
      this.history.select(commitId)
    } else if (current()) {
      toast.message(gitGraphActionOutcome(outcome, action))
    }
  }
}
