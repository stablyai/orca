import { getRepoSetupOwnerScope } from './repo-host-identity'
import type { ProjectHostSetup } from './project-types'
import { parseWslUncPath } from './wsl-paths'
import { isWindowsAbsolutePathLike, normalizeRuntimePathForComparison } from './cross-platform-path'

export type ProjectCheckoutClaim = Pick<
  ProjectHostSetup,
  | 'id'
  | 'projectId'
  | 'hostId'
  | 'repoId'
  | 'path'
  | 'kind'
  | 'setupMethod'
  | 'createdAt'
  | 'connectionId'
  | 'executionHostId'
>

export function getOutclaimedProjectSetups<T extends ProjectCheckoutClaim>(
  setups: readonly T[]
): ReadonlySet<T> {
  const claimantBySurface = new Map<string, T>()
  for (const setup of setups) {
    if (!isDistinctUserCheckout(setup)) {
      continue
    }
    const surfaceKey = getProjectSetupSurfaceKey(setup)
    const claimant = claimantBySurface.get(surfaceKey)
    if (!claimant || compareClaims(setup, claimant) < 0) {
      claimantBySurface.set(surfaceKey, setup)
    }
  }
  return new Set(
    setups.filter((setup) => {
      const claimant = claimantBySurface.get(getProjectSetupSurfaceKey(setup))
      return (
        isDistinctUserCheckout(setup) &&
        claimant !== undefined &&
        getCheckoutIdentity(claimant) !== getCheckoutIdentity(setup)
      )
    })
  )
}

function isDistinctUserCheckout(setup: ProjectCheckoutClaim): boolean {
  return setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
}

// Windows and WSL namespaces compete independently while retaining cross-surface association.
function getProjectSetupSurfaceKey(setup: ProjectCheckoutClaim): string {
  return `${setup.projectId}::${getRepoSetupOwnerScope(setup)}::${getPathSurface(setup)}`
}

function getPathSurface(setup: ProjectCheckoutClaim): string {
  const wslPath = parseWslUncPath(setup.path)
  return wslPath
    ? `wsl:${wslPath.distro.toLowerCase()}`
    : isWindowsAbsolutePathLike(setup.path)
      ? 'windows-host'
      : 'default'
}

function getCheckoutIdentity(setup: ProjectCheckoutClaim): string {
  return normalizeRuntimePathForComparison(setup.path.trim()) || setup.repoId || setup.id
}

// Stable addedAt/id order makes client and server claims agree despite enumeration order.
function compareClaims(left: ProjectCheckoutClaim, right: ProjectCheckoutClaim): number {
  const byAddedAt = left.createdAt - right.createdAt
  return byAddedAt || (left.repoId < right.repoId ? -1 : left.repoId > right.repoId ? 1 : 0)
}
