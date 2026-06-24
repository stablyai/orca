import type { GlobalSettings } from '../../../shared/types'
import type { GitLabIssueUpdate } from '../../../shared/gitlab-types'
import type { GitLabProjectRef } from '../../../shared/gitlab-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimeGitLabSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type GitLabIssueMutationResult = { ok: true } | { ok: false; error: string }

export async function gitlabUpdateIssue(
  settings: RuntimeGitLabSettings,
  args: {
    repoPath: string
    repoId?: string | null
    number: number
    projectRef?: GitLabProjectRef | null
    updates: GitLabIssueUpdate
  }
): Promise<GitLabIssueMutationResult> {
  const target = getActiveRuntimeTarget(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
  return target.kind === 'environment'
    ? callRuntimeRpc<GitLabIssueMutationResult>(
        target,
        'gitlab.updateIssue',
        {
          repo: args.repoPath,
          repoId: args.repoId ?? undefined,
          number: args.number,
          projectRef: args.projectRef ?? undefined,
          updates: args.updates
        },
        { timeoutMs: 30_000 }
      )
    : window.api.gl.updateIssue({
        repoPath: args.repoPath,
        repoId: args.repoId ?? undefined,
        number: args.number,
        projectRef: args.projectRef ?? undefined,
        updates: args.updates
      })
}
