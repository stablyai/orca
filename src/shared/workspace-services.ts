import type { WorkspacePortOwner } from './workspace-ports'

export type WorkspaceServiceKind = 'process' | 'container'

export type WorkspaceServiceContainer = {
  containerId: string
  containerName: string
  image: string
  composeProject: string | null
  state: string
}

export type WorkspaceService = {
  /** Stable across scans so React keys and selection survive a refresh. */
  id: string
  kind: WorkspaceServiceKind
  port: number
  /** Address the user should open or copy. */
  address: string
  /** App-level name, e.g. `market` inside `mono-numis-store`. Null when unknown. */
  serviceName: string | null
  /** Command a human recognizes, e.g. `pnpm dev` rather than `next-server`. */
  launchCommand: string | null
  /** Coding agent that started it, when the process chain identifies one. */
  launchedByAgent: string | null
  /** Owning project. Null renders as an em dash — never a guess. */
  projectName: string | null
  projectRoot: string | null
  /** Directory the service was started from, when known. */
  workingDir: string | null
  pid: number | null
  processName: string | null
  /** Orca worktree that owns this service, when it maps to a registered one. */
  owner: WorkspacePortOwner | null
  /** The directory this service was launched from no longer exists on disk. */
  isOrphan: boolean
  container: WorkspaceServiceContainer | null
}

export type WorkspaceServiceStopRequest =
  | { kind: 'container'; containerId: string }
  | {
      kind: 'process'
      repoId?: string
      pid: number
      port: number
      /** Write a note into the terminal of the agent that started this service. */
      notifyAgent?: boolean
      serviceName?: string | null
      projectName?: string | null
    }

/**
 * The request needed to stop this service, or null when the panel cannot stop
 * it. Null carries no reason: the caller's only use for it is hiding the
 * action, and a reason nobody renders would rot.
 */
export function resolveServiceStopRequest(
  service: WorkspaceService,
  repoId: string | null
): WorkspaceServiceStopRequest | null {
  if (service.kind === 'container') {
    return service.container
      ? { kind: 'container', containerId: service.container.containerId }
      : null
  }
  // The process path requires Orca to own the workspace: stopping an
  // unattributed listener would let the panel kill arbitrary system processes.
  if (!service.pid || !service.owner) {
    return null
  }
  return {
    kind: 'process',
    ...(repoId ? { repoId } : {}),
    pid: service.pid,
    port: service.port,
    serviceName: service.serviceName,
    projectName: service.projectName
  }
}

/** True when the panel can route a stop notice back to a launching agent. */
export function canNotifyLaunchingAgent(service: WorkspaceService): boolean {
  return service.kind === 'process' && Boolean(service.launchedByAgent) && Boolean(service.pid)
}

export type WorkspaceServiceScanResult = {
  platform: NodeJS.Platform | 'unknown'
  scannedAt: number
  services: WorkspaceService[]
  /** False when docker is absent or its daemon is down; containers are then missing. */
  dockerAvailable: boolean
  /** Set when the port scan itself could not run. */
  unavailableReason?: string
  /** Set when docker specifically could not be consulted. */
  dockerUnavailableReason?: string
}

/** Services started from the active worktree. */
export function selectServicesForWorktree(
  services: readonly WorkspaceService[],
  worktreeId: string | null | undefined
): WorkspaceService[] {
  if (!worktreeId) {
    return []
  }
  return services.filter((service) => service.owner?.worktreeId === worktreeId)
}

/** Services from other worktrees of the same repo. */
export function selectServicesForOtherWorktrees(
  services: readonly WorkspaceService[],
  repoId: string | null | undefined,
  activeWorktreeId: string | null | undefined
): WorkspaceService[] {
  if (!repoId) {
    return []
  }
  return services.filter(
    (service) => service.owner?.repoId === repoId && service.owner.worktreeId !== activeWorktreeId
  )
}

/**
 * Orphans are deliberately not filtered by project: a service whose workspace
 * was deleted has no project to filter by, and it is precisely the thing the
 * user cannot otherwise discover.
 */
export function selectOrphanServices(services: readonly WorkspaceService[]): WorkspaceService[] {
  return services.filter((service) => service.isOrphan)
}
