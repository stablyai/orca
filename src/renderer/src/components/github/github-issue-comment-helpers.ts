import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GitHubIssueCloseReason } from '../../../../shared/types'

export type GitHubIssueCommentProjectOrigin = {
  owner: string
  repo: string
  cacheKey: string
  projectItemId: string
}

export async function runIssueStateUpdate(args: {
  repoPath: string
  repoId?: string | null
  projectOrigin: GitHubIssueCommentProjectOrigin | undefined
  number: number
  updates: {
    state: 'open' | 'closed'
    stateReason?: GitHubIssueCloseReason
    duplicateOf?: number
  }
}): Promise<void> {
  if (args.projectOrigin) {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
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
  number: number
  body: string
  type?: 'issue' | 'pr'
}): Promise<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>> {
  return window.api.gh.addIssueComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    number: args.number,
    body: args.body,
    type: args.type
  })
}

export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}
