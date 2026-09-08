import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { runPullRequestStateUpdate } from '@/components/github/github-work-item-edit-mutations'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import { GITHUB_PR_MERGE_METHOD_LABELS } from '../../../../../shared/github/pull-request-merge-methods'
import type { resolveGitHubPRMergeMethods } from '../../../../../shared/github/pull-request-merge-methods'
import type {
  GitHubOwnerRepo,
  GitHubPRMergeMethod
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { translate } from '@/i18n/i18n'
import type { GitHubPRMergeStatePresentation } from '@/components/github-pr-merge-state'

export async function changePullRequestState(args: {
  canMutateState: boolean
  statePending: boolean
  nextState: 'open' | 'closed'
  localState: GitHubWorkItem['state']
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  prRepo: GitHubOwnerRepo | null
  confirm: (options: {
    title: string
    description: string
    confirmLabel: string
    confirmVariant?: 'destructive' | 'default'
  }) => Promise<boolean>
  setStatePending: (value: boolean) => void
  applyStatePatch: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
}): Promise<void> {
  if (!args.canMutateState || args.statePending) {
    return
  }
  const label =
    args.nextState === 'closed'
      ? translate('auto.components.PullRequestPage.77482513f8', 'Close')
      : translate('auto.components.PullRequestPage.2f5195c6a0', 'Reopen')
  const confirmed = await args.confirm({
    title: translate('auto.components.PullRequestPage.eec3706a6a', '{{value0}} PR #{{value1}}?', {
      value0: label,
      value1: args.item.number
    }),
    description:
      args.nextState === 'closed'
        ? translate(
            'auto.components.PullRequestPage.5a65651096',
            'This will close the pull request on GitHub.'
          )
        : translate(
            'auto.components.PullRequestPage.3d77438c92',
            'This will reopen the pull request on GitHub.'
          ),
    confirmLabel: label,
    confirmVariant: args.nextState === 'closed' ? 'destructive' : 'default'
  })
  if (!confirmed) {
    return
  }
  const previousState = args.localState
  args.setStatePending(true)
  args.applyStatePatch(args.nextState)
  try {
    await runPullRequestStateUpdate({
      repoPath: args.repoPath,
      repoId: args.repoId,
      sourceContext: args.sourceContext,
      projectOrigin: args.projectOrigin,
      number: args.item.number,
      prRepo: args.prRepo,
      updates: { state: args.nextState }
    })
    toast.success(
      args.nextState === 'closed'
        ? translate('auto.components.PullRequestPage.7aa3b5f706', 'Pull request closed')
        : translate('auto.components.PullRequestPage.710e47aa06', 'Pull request reopened')
    )
    args.onMutated()
  } catch (err) {
    args.applyStatePatch(previousState)
    // Why: full sentences per state — interpolating the localized verb into a template mangles other locales.
    toast.error(
      err instanceof Error
        ? err.message
        : args.nextState === 'closed'
          ? translate(
              'auto.components.PullRequestPage.closePullRequestFailed',
              'Failed to close pull request'
            )
          : translate(
              'auto.components.PullRequestPage.reopenPullRequestFailed',
              'Failed to reopen pull request'
            )
    )
  } finally {
    args.setStatePending(false)
  }
}

export async function mergePullRequest(args: {
  mergeDisabled: boolean
  method: GitHubPRMergeMethod
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  prRepo: GitHubOwnerRepo | null
  mergeTarget: RuntimeClientTarget
  confirm: (options: {
    title: string
    description: string
    confirmLabel: string
  }) => Promise<boolean>
  setMergePending: (value: boolean) => void
  applyStatePatch: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
}): Promise<void> {
  if (args.mergeDisabled) {
    return
  }
  const label = GITHUB_PR_MERGE_METHOD_LABELS[args.method]
  const confirmed = await args.confirm({
    title: translate('auto.components.PullRequestPage.eec3706a6a', '{{value0}} PR #{{value1}}?', {
      value0: label,
      value1: args.item.number
    }),
    description: translate(
      'auto.components.PullRequestPage.a63b3c159c',
      'This will update the pull request on GitHub.'
    ),
    confirmLabel: label
  })
  if (!confirmed) {
    return
  }
  args.setMergePending(true)
  try {
    const result =
      args.mergeTarget.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.mergePR>>>(
            args.mergeTarget,
            'github.mergePR',
            {
              repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
              prNumber: args.item.number,
              method: args.method,
              prRepo: args.prRepo
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.mergePR({
            repoPath: args.repoPath ?? '',
            repoId: args.repoId ?? undefined,
            sourceContext: args.sourceContext,
            prNumber: args.item.number,
            method: args.method,
            prRepo: args.prRepo
          })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    args.applyStatePatch('merged')
    if (args.mergeTarget.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: args.repoPath ?? '',
          repoId: args.item.repoId,
          sourceContext: args.sourceContext,
          type: 'pr',
          number: args.item.number
        },
        { local: false }
      )
    }
    toast.success(translate('auto.components.PullRequestPage.c57873d721', 'Pull request merged'))
    args.onMutated()
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.PullRequestPage.aae645d36d', 'Failed to merge pull request')
    )
  } finally {
    args.setMergePending(false)
  }
}

export async function setPullRequestAutoMerge(args: {
  canMergeWithRepoContext: boolean
  mergePresentation: GitHubPRMergeStatePresentation
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  prRepo: GitHubOwnerRepo | null
  mergeTarget: RuntimeClientTarget
  mergeMethods: ReturnType<typeof resolveGitHubPRMergeMethods>
  setMergePending: (value: boolean) => void
  onMutated: () => void
}): Promise<void> {
  if (!args.canMergeWithRepoContext || !args.mergePresentation.autoMergeAction) {
    return
  }
  const enabled = args.mergePresentation.autoMergeAction.kind === 'enable'
  args.setMergePending(true)
  try {
    const result =
      args.mergeTarget.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.setPRAutoMerge>>>(
            args.mergeTarget,
            'github.setPRAutoMerge',
            {
              repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
              prNumber: args.item.number,
              enabled,
              method: enabled ? args.mergeMethods.defaultMethod : undefined,
              prRepo: args.prRepo
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.setPRAutoMerge({
            repoPath: args.repoPath ?? '',
            repoId: args.repoId ?? undefined,
            sourceContext: args.sourceContext,
            prNumber: args.item.number,
            enabled,
            method: enabled ? args.mergeMethods.defaultMethod : undefined,
            prRepo: args.prRepo
          })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (args.mergeTarget.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: args.repoPath ?? '',
          repoId: args.item.repoId,
          sourceContext: args.sourceContext,
          type: 'pr',
          number: args.item.number
        },
        { local: false }
      )
    }
    toast.success(
      enabled
        ? translate('auto.components.PullRequestPage.5edbe7eefa', 'Auto-merge enabled')
        : translate('auto.components.PullRequestPage.0f5821b035', 'Auto-merge disabled')
    )
    args.onMutated()
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : enabled
          ? translate('auto.components.PullRequestPage.d31f4b508c', 'Failed to enable auto-merge')
          : translate('auto.components.PullRequestPage.973ef2fac9', 'Failed to disable auto-merge')
    )
  } finally {
    args.setMergePending(false)
  }
}
