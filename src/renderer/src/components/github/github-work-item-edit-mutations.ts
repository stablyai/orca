import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getGitHubMutationRoutingSettings,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import type { GitHubWorkItemProjectOrigin } from '@/components/github/github-work-item-identity'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { githubProjectHost } from '../../../../shared/github/project-identity'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

// Why: for a Project row whose repo differs from the active workspace, mutations must target the row's actual repo via slug-addressed IPCs, else edits silently apply to the workspace's repo.
// Why: these edit IPCs return `{ ok, error }`; callers throw on `!ok` so useImmediateMutation (which expects throws on failure) works unchanged.
export function getGitHubMutationSettings(repoId: string | null | undefined) {
  const state = useAppStore.getState()
  // Why: even slug-addressed project-origin mutations must run on the backing repo's owner host when its id is known.
  return getSettingsForRepoRuntimeOwner(state, repoId ?? null)
}

export async function runIssueUpdate(args: {
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
  number: number
  updates: Parameters<typeof window.api.gh.updateIssue>[0]['updates']
}): Promise<void> {
  if (args.projectOrigin) {
    const targetSettings =
      args.sourceContext?.provider === 'github'
        ? getTaskSourceRuntimeSettings(args.sourceContext)
        : getGitHubMutationSettings(args.repoId)
    const target = getActiveRuntimeTarget(targetSettings)
    const updateArgs = {
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      host: githubProjectHost(args.projectOrigin.host),
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
        : await window.api.gh.updateIssueBySlug(updateArgs)
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    if (target.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          type: 'issue',
          number: args.number
        },
        { local: false }
      )
    }
    return
  }
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (!args.repoPath && !runtimeHost) {
    throw new Error('No repo context available for this edit.')
  }
  const res = runtimeHost
    ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updateIssue>>>(
        { kind: 'environment', environmentId: runtimeHost.environmentId },
        'github.updateIssue',
        {
          repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? ''),
          number: args.number,
          updates: args.updates
        },
        { timeoutMs: 30_000 }
      )
    : await window.api.gh.updateIssue({
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        number: args.number,
        updates: args.updates
      })
  if (!res.ok) {
    throw new Error(res.error)
  }
  if (runtimeHost) {
    notifyWorkItemDetailsMutation(
      {
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        type: 'issue',
        number: args.number
      },
      { local: false }
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
    const targetSlug = args.projectOrigin
      ? {
          owner: args.projectOrigin.owner,
          repo: args.projectOrigin.repo,
          host: args.projectOrigin.host
        }
      : args.parsedSlug
    if (!targetSlug) {
      throw new Error('No GitHub repository context available for this pull request.')
    }
    const targetSettings =
      args.sourceContext?.provider === 'github'
        ? getTaskSourceRuntimeSettings(args.sourceContext)
        : getGitHubMutationSettings(args.item.repoId)
    const target = getActiveRuntimeTarget(targetSettings)
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
        : await window.api.gh.updatePullRequestBySlug(updateArgs)
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
    const targetSettings =
      args.sourceContext?.provider === 'github'
        ? getTaskSourceRuntimeSettings(args.sourceContext)
        : getGitHubMutationSettings(args.repoId)
    const target = getActiveRuntimeTarget(targetSettings)
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
        : await window.api.gh.updatePullRequestBySlug(updateArgs)
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
  const target = getActiveRuntimeTarget(
    getGitHubMutationRoutingSettings(useAppStore.getState(), args.repoId, args.sourceContext)
  )
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
    throw new Error(res.error)
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
