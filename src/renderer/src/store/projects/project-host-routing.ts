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
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '../../runtime/runtime-rpc-client'
import { getRuntimeTargetHostId } from '../runtime-target-host'

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

export function setupWithFetchedOwner(
  setup: ProjectHostSetup,
  target: RuntimeClientTarget
): ProjectHostSetup {
  const hostId = getRuntimeTargetHostId(target)
  if (target.kind !== 'environment') {
    return setup
  }
  const executionHostId = setup.executionHostId ?? setup.hostId
  return {
    ...setup,
    hostId,
    executionHostId: executionHostId === LOCAL_EXECUTION_HOST_ID ? hostId : executionHostId,
    runtimeOwnerEnvironmentId: target.environmentId,
    // Why: paired clients route through the HUB and must not treat its private SSH target as client-local configuration.
    connectionId: null
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
      return {
        projects: await projectsApi.list(),
        setups: await projectsApi.listHostSetups()
      }
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
      projects: projectResponse.projects,
      setups: setupResponse.setups.map((setup) => setupWithFetchedOwner(setup, target))
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
