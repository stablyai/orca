import type { AppState } from '../types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupExistingFolderArgs
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../../shared/project-host-setup-projection'
import {
  normalizeProjectHostSetupRows,
  normalizeProjectRows
} from '../../../../shared/project-catalog-row-normalization'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '../../runtime/runtime-rpc-client'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { adoptFromEndpoint } from '../adopt-from-endpoint'

export function getProjectSetupRuntimeTarget(
  hostId: ProjectHostSetupExistingFolderArgs['hostId']
): RuntimeClientTarget {
  const parsedHost = parseExecutionHostId(hostId)
  return parsedHost?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsedHost.environmentId }
    : { kind: 'local' }
}

export function getProjectUpdateRuntimeTarget(
  state: AppState,
  projectId: string
): RuntimeClientTarget {
  const target = getActiveRuntimeTarget(state.settings)
  if (target.kind !== 'environment') {
    return target
  }
  const runtimeHostId = getRuntimeTargetHostId(target)
  return state.projectHostSetups.some(
    (setup) => setup.projectId === projectId && setup.hostId === runtimeHostId
  )
    ? target
    : { kind: 'local' }
}

function normalizeProjectCatalogProjection(
  projection: ProjectHostSetupProjection
): ProjectHostSetupProjection {
  return {
    projects: normalizeProjectRows([...projection.projects]),
    setups: normalizeProjectHostSetupRows([...projection.setups])
  }
}

async function assertProjectHostSetupRuntimeCapability(target: RuntimeClientTarget): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
    'The selected Orca server does not support project host setup yet. Update Orca on the server and try again.',
    15_000
  )
}

export async function fetchProjectHostSetupCompatibility(
  target: RuntimeClientTarget,
  repos: readonly Repo[]
): Promise<ProjectHostSetupProjection> {
  try {
    if (target.kind === 'local') {
      const projectsApi = (
        window.api as typeof window.api & {
          projects?: {
            list?: () => Promise<Project[]>
            listHostSetups?: () => Promise<ProjectHostSetup[]>
          }
        }
      ).projects
      if (!projectsApi?.list || !projectsApi.listHostSetups) {
        throw new Error('projects_api_unavailable')
      }
      return normalizeProjectCatalogProjection({
        projects: await projectsApi.list(),
        setups: await projectsApi.listHostSetups()
      })
    }
    await assertProjectHostSetupRuntimeCapability(target)
    const [projectResponse, setupResponse] = await Promise.all([
      callRuntimeRpc<{ projects: Project[] }>(target, 'project.list', undefined, {
        timeoutMs: 15_000
      }),
      callRuntimeRpc<{ setups: ProjectHostSetup[] }>(target, 'projectHostSetup.list', undefined, {
        timeoutMs: 15_000
      })
    ])
    return {
      // Why projects too: the same wire response carries them, and a remote host on another
      // Orca version can publish a row whose declared field types do not hold.
      projects: normalizeProjectRows([...projectResponse.projects]),
      setups: setupResponse.setups.map((setup) =>
        adoptFromEndpoint(target, { kind: 'projectHostSetup', row: setup })
      )
    }
  } catch {
    // Why: newer clients must hydrate against older runtimes that only know repo.list; derive the transitional model locally.
    return projectHostSetupProjectionFromRepos(repos)
  }
}

export async function assertProjectHostSetupMutationRuntimeCapabilities(
  target: RuntimeClientTarget
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertProjectHostSetupRuntimeCapability(target)
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
    'The selected Orca server does not support explicit workspace run hosts yet. Update Orca on the server and try again.',
    15_000
  )
}
