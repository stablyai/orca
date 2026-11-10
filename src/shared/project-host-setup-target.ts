import type { ExecutionHostId } from './execution-host'

export const SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE =
  "This Orca server can't add projects on its SSH hosts. Add the SSH host on your computer to open its projects."

/** Projects on an SSH host live in its Orca server, which only connecting the host sets up. */
export function sshHostWithoutServerMessage(hostLabel: string): string {
  return `No Orca server is running on ${hostLabel} yet. Connect the host to set one up, then try again.`
}

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
