import type { ExecutionHostId } from './execution-host'

/**
 * Names one setup. Repo-backed setups take the repo id, so twins on different hosts share
 * `setupId` and `hostId` picks the host; older clients omit it and keep the first match by id.
 */
export type ProjectHostSetupTarget = {
  setupId: string
  hostId?: ExecutionHostId
}

type SetupIdentity = { id: string; hostId: string }

export function findProjectHostSetup<T extends SetupIdentity>(
  setups: readonly T[],
  target: ProjectHostSetupTarget
): T | undefined {
  return setups.find(
    (setup) =>
      setup.id === target.setupId && (target.hostId === undefined || setup.hostId === target.hostId)
  )
}
