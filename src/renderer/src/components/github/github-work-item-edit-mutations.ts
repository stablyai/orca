import { getGitHubMutationTarget } from './github-work-item-mutation-target'
export { getGitHubMutationTarget } from './github-work-item-mutation-target'
import { callGitHubTargetOperation } from '@/lib/github-work-item-target-request'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getGitHubRepoRoutingTarget,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import {
  resolvePullRequestRepo,
  type GitHubWorkItemProjectOrigin
} from '@/components/github/github-work-item-identity'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { codeHostErrorText } from '@/lib/code-host-error-copy'

export async function runIssueUpdate(args: {
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
  issueRepo?: GitHubOwnerRepo | null
  type?: 'issue' | 'pr'
  number: number
  updates: Parameters<typeof window.api.gh.updateIssue>[0]['updates']
}): Promise<void> {
  const issueRepo = args.projectOrigin
  if (issueRepo) {
    const target =
      args.sourceContext?.provider === 'github'
        ? taskSourceRuntimeTarget(args.sourceContext)
        : getGitHubMutationTarget(args.repoId, args.projectOrigin)
    const updateArgs = {
      owner: issueRepo.owner,
      repo: issueRepo.repo,
      host: githubProjectHost(issueRepo.host),
      number: args.number,
      updates: args.updates
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updateIssueBySlug>>>(
            target,
            'github.project.updateIssueBySlug',
            updateArgs,
            {
              timeoutMs: 30_000
            }
          )
        : await window.api.gh.updateIssueBySlug({ ...updateArgs, wakeWslDistro: true })
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    notifyWorkItemDetailsMutation(
      {
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        type: args.type ?? 'issue',
        number: args.number
      },
      { local: target.kind !== 'environment' }
    )
    return
  }
  if (!args.issueRepo) {
    throw new Error('Unable to identify this GitHub item. Open it again from Tasks.')
  }
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (!args.repoPath && !runtimeHost) {
    throw new Error('No repo context available for this edit.')
  }
  const res = await callGitHubTargetOperation({
    target: runtimeHost
      ? { kind: 'environment', environmentId: runtimeHost.environmentId }
      : { kind: 'local' },
    ownerRepo: args.issueRepo,
    method: 'github.updateIssue',
    params: {
      repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? ''),
      number: args.number,
      updates: args.updates
    },
    local: (exact) =>
      window.api.gh.updateIssue({
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        number: args.number,
        updates: args.updates,
        ...exact
      })
  })
  if (!res.ok) {
    throw new Error(codeHostErrorText(res))
  }
  if (runtimeHost || args.type === 'pr') {
    notifyWorkItemDetailsMutation(
      {
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        type: args.type ?? 'issue',
        number: args.number
      },
      { local: !runtimeHost }
    )
  }
}

export async function runWorkItemBodyUpdate(args: {
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
  body: string
  parsedSlug: GitHubOwnerRepo | null
}): Promise<void> {
  if (args.item.type === 'pr') {
    const targetSlug = resolvePullRequestRepo(args.item, args.projectOrigin) ?? args.parsedSlug
    if (!targetSlug) {
      throw new Error('No GitHub repository context available for this pull request.')
    }
    const target =
      args.sourceContext?.provider === 'github'
        ? taskSourceRuntimeTarget(args.sourceContext)
        : getGitHubMutationTarget(args.item.repoId, args.projectOrigin)
    const updateArgs = {
      owner: targetSlug.owner,
      repo: targetSlug.repo,
      host: githubProjectHost(targetSlug.host),
      number: args.item.number,
      updates: { body: args.body }
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePullRequestBySlug>>>(
            target,
            'github.project.updatePullRequestBySlug',
            updateArgs,
            {
              timeoutMs: 30_000
            }
          )
        : await window.api.gh.updatePullRequestBySlug({ ...updateArgs, wakeWslDistro: true })
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    if (target.kind === 'environment') {
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
    return
  }

  await runIssueUpdate({
    repoPath: args.repoPath,
    repoId: args.item.repoId,
    sourceContext: args.sourceContext,
    projectOrigin: args.projectOrigin,
    issueRepo: args.parsedSlug,
    number: args.item.number,
    updates: { body: args.body }
  })
}

export async function runPullRequestStateUpdate(args: {
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
  number: number
  prRepo?: GitHubOwnerRepo | null
  updates: { state: 'open' | 'closed' }
}): Promise<void> {
  if (args.projectOrigin) {
    const target =
      args.sourceContext?.provider === 'github'
        ? taskSourceRuntimeTarget(args.sourceContext)
        : getGitHubMutationTarget(args.repoId, args.projectOrigin)
    const updateArgs = {
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      host: githubProjectHost(args.projectOrigin.host),
      number: args.number,
      updates: args.updates
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePullRequestBySlug>>>(
            target,
            'github.project.updatePullRequestBySlug',
            updateArgs,
            {
              timeoutMs: 30_000
            }
          )
        : await window.api.gh.updatePullRequestBySlug({ ...updateArgs, wakeWslDistro: true })
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    if (target.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          type: 'pr',
          number: args.number
        },
        { local: false }
      )
    }
    return
  }
  // Why: close/reopen must route by the repo owner host like merge (#6957).
  const target = getGitHubRepoRoutingTarget(useAppStore.getState(), args.repoId, args.sourceContext)
  if (!args.repoPath && target.kind !== 'environment') {
    throw new Error('No repo context available for this pull request.')
  }
  const res =
    target.kind === 'environment'
      ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePRState>>>(
          target,
          'github.updatePRState',
          {
            repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? ''),
            prNumber: args.number,
            prRepo: args.prRepo ?? null,
            updates: args.updates
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.updatePRState({
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          prNumber: args.number,
          prRepo: args.prRepo ?? null,
          updates: args.updates
        })
  if (!res.ok) {
    throw new Error(codeHostErrorText(res))
  }
  if (target.kind === 'environment') {
    notifyWorkItemDetailsMutation(
      {
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        type: 'pr',
        number: args.number
      },
      { local: false }
    )
  }
}
