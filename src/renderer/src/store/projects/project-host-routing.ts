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
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { adoptEndpointProjectCatalog } from '../../../../shared/endpoint-catalog-adoption'
import {
  SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE,
  type ProjectHostSetupTarget
} from '../../../../shared/project-host-setup-target'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { AppState } from '../types'

export function getProjectSetupRuntimeTarget(
  hostId: ProjectHostSetupExistingFolderArgs['hostId']
): RuntimeClientTarget {
  const parsedHost = parseExecutionHostId(hostId)
  return parsedHost?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsedHost.environmentId }
    : { kind: 'local' }
}

// Why before dispatch: no process sets up `ssh:` hosts (managed ones are `runtime:`), and a
// paired server's SSH host would otherwise reach this client's own API.
export function assertNotSshProjectHost(
  state: Pick<AppState, 'sshTargetLabels' | 'sshStateByEnvironment'>,
  hostId: ExecutionHostId
): void {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'ssh') {
    return
  }
  throw new Error(
    isPairedServerSshTarget(state, parsed.targetId)
      ? SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
      : `SSH connection "${parsed.targetId}" not found or not connected`
  )
}

/**
 * SSH hosts a paired server owns: the server reaches their runtime over its own tunnel, which this
 * client has no route to (#29593). A web client only ever sees its server's hosts.
 */
function isPairedServerSshTarget(
  state: Pick<AppState, 'sshTargetLabels' | 'sshStateByEnvironment'>,
  targetId: string
): boolean {
  if (isWebClientLocation()) {
    return true
  }
  if (state.sshTargetLabels.has(targetId)) {
    return false
  }
  return [...state.sshStateByEnvironment.values()].some((bucket) =>
    bucket.targetLabels.has(targetId)
  )
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
      return adoptEndpointProjectCatalog(
        target,
        await projectsApi.list(),
        await projectsApi.listHostSetups()
      )
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
    return adoptEndpointProjectCatalog(target, projectResponse.projects, setupResponse.setups)
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

// Twins share IDs; paired server setups all use one client runtime hostId, so server-side by-ID resolution remains authoritative.
export function isSameProjectHostSetup(a: ProjectHostSetup, b: ProjectHostSetup): boolean {
  return a.id === b.id && a.hostId === b.hostId
}

export function upsertProjectHostSetup(
  setups: readonly ProjectHostSetup[],
  setup: ProjectHostSetup
): ProjectHostSetup[] {
  return setups.some((entry) => isSameProjectHostSetup(entry, setup))
    ? setups.map((entry) => (isSameProjectHostSetup(entry, setup) ? setup : entry))
    : [...setups, setup]
}

/** Local named/twin setup edits send real host identity; paired requests stay by-ID because client runtime hostIds cannot name server-side twins. */
export async function prepareProjectHostSetupMutation<T extends ProjectHostSetupTarget>(
  setups: readonly ProjectHostSetup[],
  args: T
): Promise<{ target: RuntimeClientTarget; hostArgs: T }> {
  const setup = setups.find(
    (entry) =>
      entry.id === args.setupId && (args.hostId === undefined || entry.hostId === args.hostId)
  )
  if (!setup && args.hostId !== undefined) {
    // Why: an id-only fallback could land on a same-id setup of another host.
    throw new Error(`Project host setup not found on ${args.hostId}: ${args.setupId}`)
  }
  const target = setup ? getProjectSetupRuntimeTarget(setup.hostId) : { kind: 'local' as const }
  await assertProjectHostSetupMutationRuntimeCapabilities(target)
  if (!setup || target.kind === 'environment') {
    return { target, hostArgs: { ...args, hostId: undefined } }
  }
  const twinned = setups.some(
    (entry) => entry !== setup && entry.id === setup.id && entry.hostId !== setup.hostId
  )
  return {
    target,
    hostArgs: twinned || args.hostId !== undefined ? { ...args, hostId: setup.hostId } : args
  }
}
