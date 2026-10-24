import type { ExecutionHostId } from './execution-host'

/** Repo IDs can repeat across hosts; hostId selects the intended setup, while older clients omit it and retain first-ID matching. */
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
