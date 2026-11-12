import type { GitHubImageUploadAddress } from './github-image-upload'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost
} from '@/lib/work-items/github/github-source-runtime-context'

export function githubCommentImageUploadAddress(args: {
  repoId?: string | null
  repoPath: string
  sourceContext?: TaskSourceContext | null
  type: 'issue' | 'pr'
  prRepo?: GitHubOwnerRepo | null
}): GitHubImageUploadAddress {
  const host = getGitHubSourceRuntimeHost(args.sourceContext)
  return {
    runtime: host ? { kind: 'environment', environmentId: host.environmentId } : { kind: 'local' },
    target: {
      kind: 'repo',
      repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId) ?? `path:${args.repoPath}`,
      source: args.type === 'pr' ? 'origin' : 'issue',
      ...(args.prRepo ? { ownerRepo: args.prRepo } : {})
    }
  }
}
