import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE
} from '../file-access/files-runtime-capabilities'
import type { RuntimeStatus } from '../remote-runtime/session-graph/runtime-session-contracts'

export function assertFileMutationOwnershipCapability(
  status: Pick<RuntimeStatus, 'capabilities'>
): void {
  if (!status.capabilities?.includes(FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY)) {
    throw new Error(FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE)
  }
}
