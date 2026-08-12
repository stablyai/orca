import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { Repo } from '../../../shared/types'

/** The repo-backed beads source context. Every producer must mint the same
 *  cache scope (identity prefix unknown pre-fetch → cache part ''), or warm
 *  fetches and detail reads miss each other. */
export function buildBeadsRepoTaskSourceContext(repo: Repo): TaskSourceContext | null {
  const projection = projectHostSetupProjectionFromRepos([repo])
  const setup = projection.setups[0]
  const project = projection.projects[0]
  return normalizeTaskSourceContext({
    provider: 'beads',
    projectId: setup?.projectId ?? project?.id ?? repo.id,
    hostId: setup?.hostId ?? getRepoExecutionHostId(repo),
    projectHostSetupId: setup?.id,
    repoId: repo.id,
    providerIdentity: null
  })
}
