import { captureGitHubTaskObservation } from '@/lib/github-task-observation'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { AppState } from '../types'

export function captureGitHubTaskReadDomains(
  sources: readonly { repoId: string; path?: string; sourceContext?: TaskSourceContext | null }[],
  state?: Pick<AppState, 'repos'>
) {
  const lookup = getGitHubRepoLookupIndex(state?.repos)
  const owners = sources.map((source) => {
    const repo = source.sourceContext?.hostId
      ? source.path
        ? lookup.findOnHost(source.sourceContext.hostId, source.repoId, source.path)
        : lookup.findByHostAndId(source.sourceContext.hostId, source.repoId)
      : lookup.findByIdOrPath(source.repoId, source.path ?? '')
    return { source, observation: repo && captureGitHubTaskObservation(repo, source.sourceContext) }
  })
  const scopes = new Set(
    owners.flatMap((owner) => (owner.observation ? [owner.observation.key] : []))
  )
  const legacy = new Set(
    owners
      .filter((owner) => !owner.observation)
      .map((owner) =>
        JSON.stringify([owner.source.repoId, githubTaskSourceKey(owner.source.sourceContext)])
      )
  )
  const listDomains = new Set(
    owners.flatMap((owner) =>
      owner.observation
        ? owner.observation.associations.map((association) =>
            JSON.stringify([owner.source.repoId, association.scope])
          )
        : [JSON.stringify([owner.source.repoId, githubTaskSourceKey(owner.source.sourceContext)])]
    )
  )
  return { scopes, legacy, listDomains }
}
