import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type {
  GitHubIssueCloseReason,
  GitHubWorkItem,
  GlobalSettings
} from '../../../../shared/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type GitHubIssueCommentProjectOrigin = {
  owner: string
  repo: string
  cacheKey: string
  projectItemId: string
}

export async function runIssueStateUpdate(args: {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  sourceSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  projectOrigin: GitHubIssueCommentProjectOrigin | undefined
  issueSourcePreference?: GitHubWorkItem['issueSourcePreference']
  number: number
  updates: {
    state: 'open' | 'closed'
    stateReason?: GitHubIssueCloseReason
    duplicateOf?: number
  }
}): Promise<void> {
  if (args.projectOrigin) {
    const target = getActiveRuntimeTarget(args.sourceSettings ?? useAppStore.getState().settings)
    const updateArgs = {
      owner: args.projectOrigin.owner,
      repo: args.projectOrigin.repo,
      number: args.number,
      updates: args.updates
    }
    const res =
      target.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updateIssueBySlug>>>(
            target,
            'github.project.updateIssueBySlug',
            updateArgs,
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateIssueBySlug(updateArgs)
    if (!res.ok) {
      throw new Error(res.error.message)
    }
    return
  }
  const state = useAppStore.getState()
  const target = getActiveRuntimeTarget(args.sourceSettings ?? state.settings)
  const runtimeRepoSelector =
    args.sourceContext?.provider === 'github'
      ? (args.sourceContext.repoId ?? args.repoId ?? args.repoPath)
      : (args.repoId ?? args.repoPath)
  const res =
    target.kind === 'environment'
      ? await callRuntimeRpc<{ ok?: boolean; error?: string }>(
          target,
          'github.updateIssue',
          {
            repo: runtimeRepoSelector,
            issueSourcePreference: args.issueSourcePreference ?? undefined,
            number: args.number,
            updates: args.updates
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.updateIssue({
          repoPath: args.repoPath,
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          issueSourcePreference: args.issueSourcePreference ?? undefined,
          number: args.number,
          updates: args.updates
        })
  if (!res.ok) {
    throw new Error(res.error)
  }
}

export async function addIssueCommentForRepo(args: {
  repoId?: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  sourceSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  number: number
  body: string
  type?: 'issue' | 'pr'
  issueSourcePreference?: GitHubWorkItem['issueSourcePreference']
}): Promise<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>> {
  const target = getActiveRuntimeTarget(args.sourceSettings ?? useAppStore.getState().settings)
  const runtimeRepoSelector =
    args.sourceContext?.provider === 'github'
      ? (args.sourceContext.repoId ?? args.repoId ?? args.repoPath)
      : (args.repoId ?? args.repoPath)
  const runtimeRepoId =
    args.sourceContext?.provider === 'github'
      ? (args.sourceContext.repoId ?? args.repoId ?? undefined)
      : (args.repoId ?? undefined)
  return target.kind === 'environment'
    ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>(
        target,
        'github.addIssueComment',
        {
          repo: runtimeRepoSelector,
          repoId: runtimeRepoId,
          number: args.number,
          body: args.body,
          type: args.type,
          issueSourcePreference: args.issueSourcePreference ?? undefined
        },
        { timeoutMs: 30_000 }
      )
    : window.api.gh.addIssueComment({
        repoPath: args.repoPath,
        repoId: args.repoId,
        sourceContext: args.sourceContext,
        number: args.number,
        body: args.body,
        type: args.type,
        issueSourcePreference: args.issueSourcePreference ?? undefined
      })
}

export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}
