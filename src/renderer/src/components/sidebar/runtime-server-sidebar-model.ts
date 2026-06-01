import type { Repo, Worktree } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

export type RuntimeServerProjectState =
  | { status: 'idle'; repos: Repo[]; error: null }
  | { status: 'loading'; repos: Repo[]; error: null }
  | { status: 'ready'; repos: Repo[]; error: null }
  | { status: 'error'; repos: Repo[]; error: string }

export type RuntimeServerEntry =
  | {
      id: null
      label: string
      active: boolean
      kind: 'local'
      projects: RuntimeServerProjectState
    }
  | {
      id: string
      label: string
      active: boolean
      kind: 'remote'
      endpoint: string | null
      projects: RuntimeServerProjectState
    }

const RUNTIME_SERVER_PROJECT_ERROR_LABEL = 'Failed to load projects'

export function createEmptyRuntimeServerProjectState(): RuntimeServerProjectState {
  return {
    status: 'idle',
    repos: [],
    error: null
  }
}

export function getProjectStateWithLoading(
  current: RuntimeServerProjectState | undefined
): RuntimeServerProjectState {
  return {
    status: 'loading',
    repos: current?.repos ?? [],
    error: null
  }
}

export function getRuntimeServerErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

export function sortRuntimeServerProjects(repos: Repo[]): Repo[] {
  return [...repos].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function getRuntimeServerProjectLabel(state: RuntimeServerProjectState): string {
  if (state.status === 'idle') {
    return 'Not loaded'
  }
  if (state.status === 'loading') {
    return 'Loading projects...'
  }
  if (state.status === 'error') {
    return state.error.trim() || RUNTIME_SERVER_PROJECT_ERROR_LABEL
  }
  const count = state.repos.length
  return `${count} project${count === 1 ? '' : 's'}`
}

export function getRuntimeServerProjectActivationWorktree(
  worktrees: readonly Worktree[]
): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

function getRuntimeServerEndpoint(environment: PublicKnownRuntimeEnvironment): string | null {
  return (
    environment.endpoints.find((endpoint) => endpoint.id === environment.preferredEndpointId)
      ?.endpoint ??
    environment.endpoints[0]?.endpoint ??
    null
  )
}

export function buildRuntimeServerEntries(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  environments: readonly PublicKnownRuntimeEnvironment[]
  localProjects: RuntimeServerProjectState
  remoteProjectsByEnvironmentId: ReadonlyMap<string, RuntimeServerProjectState>
}): RuntimeServerEntry[] {
  const activeId = args.activeRuntimeEnvironmentId?.trim() || null
  const entries: RuntimeServerEntry[] = [
    {
      id: null,
      label: 'Local',
      active: activeId === null,
      kind: 'local',
      projects: args.localProjects
    }
  ]

  for (const environment of args.environments) {
    entries.push({
      id: environment.id,
      label: environment.name,
      active: activeId === environment.id,
      kind: 'remote',
      endpoint: getRuntimeServerEndpoint(environment),
      projects:
        args.remoteProjectsByEnvironmentId.get(environment.id) ??
        createEmptyRuntimeServerProjectState()
    })
  }

  return entries
}
