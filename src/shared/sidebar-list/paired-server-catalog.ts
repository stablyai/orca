import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../execution-host'
import { adoptEndpointProjectCatalog, adoptEndpointRepo } from '../endpoint-catalog-adoption'
import { ProjectGroupSchema } from '../project-section-catalog-schema'
import type { ProjectGroup } from '../project-group-types'
import { projectHostSetupProjectionFromRepos } from '../project-host-setup-projection'
import type { Project, ProjectHostSetup } from '../project-types'
import type { Repo } from '../repo-types'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import type { PairedServerCatalog } from './sidebar-project-catalog'
import { salvagingArray } from '../zod-salvage'

// The server's own rows as it sends them; the adoption and projection steps normalize the rest.
function rowWith<T>(...keys: string[]) {
  const identity = z.looseObject(Object.fromEntries(keys.map((key) => [key, z.string()])))
  return z.custom<T>((value) => identity.safeParse(value).success)
}

const RepoListReplySchema = z.object({
  repos: salvagingArray(rowWith<Repo>('id', 'path', 'displayName'))
})
const ProjectGroupListReplySchema = z.object({ groups: salvagingArray(ProjectGroupSchema) })
const ProjectListReplySchema = z.object({ projects: salvagingArray(rowWith<Project>('id')) })
const ProjectHostSetupListReplySchema = z.object({
  setups: salvagingArray(rowWith<ProjectHostSetup>('id', 'projectId', 'repoId'))
})

function answer<Schema extends z.ZodType>(
  response: PromiseSettledResult<RuntimeRpcResponse<unknown>>,
  schema: Schema
): z.output<Schema> | null {
  if (response.status !== 'fulfilled' || !response.value.ok) {
    return null
  }
  const parsed = schema.safeParse(response.value.result)
  return parsed.success ? parsed.data : null
}

/**
 * The reads the window's all-host catalog makes of a server (repo.list, projectGroup.list,
 * project.list, projectHostSetup.list). Null when repo.list fails; `previous` keeps the groups a
 * failed group read would otherwise drop.
 */
export async function fetchPairedServerCatalog(
  environmentId: string,
  call: (method: string) => Promise<RuntimeRpcResponse<unknown>>,
  previous: PairedServerCatalog | null
): Promise<PairedServerCatalog | null> {
  const [repoReply, groupReply, projectReply, setupReply] = await Promise.allSettled(
    ['repo.list', 'projectGroup.list', 'project.list', 'projectHostSetup.list'].map(call)
  )
  const repoList = answer(repoReply, RepoListReplySchema)
  if (!repoList) {
    return null
  }
  const target = { kind: 'environment', environmentId } as const
  const hostId = toRuntimeExecutionHostId(environmentId)
  const repos = repoList.repos.map((repo) => adoptEndpointRepo(target, repo))
  const groups = answer(groupReply, ProjectGroupListReplySchema)?.groups.map(
    (group): ProjectGroup => ({ ...group, executionHostId: hostId })
  )
  const projects = answer(projectReply, ProjectListReplySchema)?.projects
  const setups = answer(setupReply, ProjectHostSetupListReplySchema)?.setups
  return {
    hostId,
    repos,
    projectGroups: groups ?? previous?.projectGroups ?? [],
    // Why the derived projection: an older server answers repo.list but not the project reads.
    projection:
      projects && setups
        ? adoptEndpointProjectCatalog(target, projects, setups)
        : projectHostSetupProjectionFromRepos(repos)
  }
}
