import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { isWslUncPath } from '../../../../shared/wsl-paths'

export type ProjectSetupIneligibleReason =
  | 'no_setup_on_host'
  | 'direct_ssh'
  | 'wsl'
  | 'folder'
  | 'not_ready'

export type ProjectSetupResolution =
  | {
      status: 'resolved'
      setup: ProjectHostSetup
      /** Every eligible setup on the host, default first; more than one means the chip shows the setup. */
      eligible: readonly ProjectHostSetup[]
    }
  | { status: 'unavailable'; reason: ProjectSetupIneligibleReason }

/** Order of the host's own validation: folder, direct SSH, then WSL. */
function ineligibleReason(setup: ProjectHostSetup): ProjectSetupIneligibleReason | null {
  if (setup.kind === 'folder') {
    return 'folder'
  }
  if (setup.connectionId || setup.hostId.startsWith('ssh:')) {
    return 'direct_ssh'
  }
  if (isWslUncPath(setup.path)) {
    return 'wsl'
  }
  return setup.setupState === 'ready' ? null : 'not_ready'
}

/** Oldest first, then smallest id: the single default rule for picker, chip and create. */
function compareDefaultSetup(a: ProjectHostSetup, b: ProjectHostSetup): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Picks the setup a multi-repo member uses for a project on the workspace host.
 * `override` is a setup id from the chip menu; it is honored only while it is still eligible on
 * this host, so a host switch silently falls back to the default instead of using a stale choice.
 */
export function resolveProjectSetupForHost(
  projectId: string,
  hostId: ExecutionHostId,
  setups: readonly ProjectHostSetup[],
  override?: string | null
): ProjectSetupResolution {
  const onHost = setups
    .filter((setup) => setup.projectId === projectId && setup.hostId === hostId)
    .sort(compareDefaultSetup)
  if (onHost.length === 0) {
    return { status: 'unavailable', reason: 'no_setup_on_host' }
  }
  const eligible = onHost.filter((setup) => ineligibleReason(setup) === null)
  if (eligible.length === 0) {
    const reason = ineligibleReason(onHost[0])
    return { status: 'unavailable', reason: reason ?? 'not_ready' }
  }
  const chosen =
    (override ? eligible.find((setup) => setup.id === override) : undefined) ?? eligible[0]
  const ordered = [chosen, ...eligible.filter((setup) => setup !== chosen)]
  return { status: 'resolved', setup: chosen, eligible: ordered }
}

/** Hosts where the project has an eligible setup, for the "Use <other host>" link. */
export function listProjectEligibleHostIds(
  projectId: string,
  setups: readonly ProjectHostSetup[]
): ExecutionHostId[] {
  const hostIds = new Set(
    setups.filter((setup) => setup.projectId === projectId).map((setup) => setup.hostId)
  )
  return [...hostIds].filter(
    (hostId) => resolveProjectSetupForHost(projectId, hostId, setups).status === 'resolved'
  )
}

export type SelectedProjectResolution = {
  projectId: string
  resolution: ProjectSetupResolution
}

/** Re-resolves the whole selection; projects without a setup stay listed so the UI can show an error chip. */
export function resolveSelectedProjects(
  projectIds: readonly string[],
  hostId: ExecutionHostId,
  setups: readonly ProjectHostSetup[],
  overrides: Readonly<Record<string, string | undefined>> = {}
): SelectedProjectResolution[] {
  return projectIds.map((projectId) => ({
    projectId,
    resolution: resolveProjectSetupForHost(projectId, hostId, setups, overrides[projectId])
  }))
}
