import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GitHubIssueCloseReason, GlobalSettings } from '../../../../shared/types'
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
  const res = await window.api.gh.updateIssue({
    repoPath: args.repoPath,
    repoId: args.repoId ?? undefined,
    sourceContext: args.sourceContext,
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
  number: number
  body: string
  type?: 'issue' | 'pr'
}): Promise<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>> {
  return window.api.gh.addIssueComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    number: args.number,
    body: args.body,
    type: args.type
  })
}

export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}
