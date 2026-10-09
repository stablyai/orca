import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup, ProjectHostSetupDeleteArgs } from '../../../../shared/project-types'
import { getProjectHostSetupOwnerKey } from './project-compatibility-core'

export function resolveProjectHostSetupMutation(
  setups: readonly ProjectHostSetup[],
  args: ProjectHostSetupDeleteArgs & { owner?: ProjectHostSetup; ownerHostId?: ExecutionHostId }
): ProjectHostSetup {
  const matches = setups.filter(
    (setup) =>
      setup.id === args.setupId &&
      (args.ownerHostId === undefined || setup.hostId === args.ownerHostId) &&
      (args.executionHostId === undefined ||
        (setup.authoritativeExecutionHostId ?? setup.hostId) === args.executionHostId) &&
      (!args.owner ||
        getProjectHostSetupOwnerKey(setup) === getProjectHostSetupOwnerKey(args.owner))
  )
  if (matches.length !== 1) {
    throw new Error(
      `Project host setup ${matches.length ? 'is ambiguous' : 'was not found'}: ${args.setupId}`
    )
  }
  return matches[0]
}
