import type { GitHubIssueUpdate, GlobalSettings, Repo } from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimeGitHubSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type GitHubIssueMutationResult = { ok: true } | { ok: false; error: string }

function isTaskSourceContext(settings: RuntimeGitHubSettings): settings is TaskSourceContext {
  return Boolean(settings && 'kind' in settings)
}

export async function githubUpdateIssue(
  settings: RuntimeGitHubSettings,
  args: {
    repoPath: string
    repoId?: string | null
    issueSourcePreference?: Repo['issueSourcePreference']
    number: number
    updates: GitHubIssueUpdate
  }
): Promise<GitHubIssueMutationResult> {
  const sourceContext = isTaskSourceContext(settings) ? settings : null
  const plainSettings = isTaskSourceContext(settings) ? null : settings
  const targetSettings = sourceContext ? getTaskSourceRuntimeSettings(sourceContext) : plainSettings
  const target = getActiveRuntimeTarget(targetSettings)
  // Why: task-source GitHub mutations must prefer the source repo identity so
  // origin/upstream issue numbers do not drift to the local fallback repo.
  const runtimeRepoSelector =
    sourceContext?.provider === 'github'
      ? (sourceContext.repoId ?? args.repoId ?? args.repoPath)
      : (args.repoId ?? args.repoPath)
  return target.kind === 'environment'
    ? callRuntimeRpc<GitHubIssueMutationResult>(
        target,
        'github.updateIssue',
        {
          repo: runtimeRepoSelector,
          repoId:
            sourceContext?.provider === 'github'
              ? (sourceContext.repoId ?? args.repoId ?? undefined)
              : (args.repoId ?? undefined),
          issueSourcePreference: args.issueSourcePreference,
          number: args.number,
          updates: args.updates
        },
        { timeoutMs: 30_000 }
      )
    : window.api.gh.updateIssue({
        repoPath: args.repoPath,
        repoId: args.repoId ?? undefined,
        sourceContext,
        issueSourcePreference: args.issueSourcePreference,
        number: args.number,
        updates: args.updates
      })
}
