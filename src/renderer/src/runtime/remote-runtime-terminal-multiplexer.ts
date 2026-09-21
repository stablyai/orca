import {
  exposeE2eRemoteTerminalMultiplexAckGate,
  resetRemoteRuntimeTerminalE2eState
} from './remote-runtime-terminal-e2e-control'
import type { RemoteRuntimeTerminalMultiplexerBase } from './remote-runtime-terminal-multiplexer-base'
import { RemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer-implementation'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export {
  REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE
} from './remote-runtime-terminal-snapshot-state'
export { isHostAnsweredSnapshotRetryCause } from './remote-runtime-terminal-multiplexer-types'
export type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks,
  RemoteRuntimeSnapshotAvailability,
  RemoteRuntimeSnapshotHostRetryCause,
  RemoteRuntimeSnapshotImage,
  RemoteRuntimeSnapshotLocalRetryCause,
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotPermanentReason,
  RemoteRuntimeSnapshotRetryCause
} from './remote-runtime-terminal-multiplexer-types'

const multiplexers = new Map<string, RemoteRuntimeTerminalMultiplexer>()

function releaseRemoteRuntimeTerminalMultiplexer(
  environmentId: string,
  multiplexer: RemoteRuntimeTerminalMultiplexerBase
): void {
  if (multiplexers.get(environmentId) === multiplexer) {
    multiplexers.delete(environmentId)
  }
}

export function getRemoteRuntimeTerminalMultiplexer(
  environmentId: string
): RemoteRuntimeTerminalMultiplexer {
  exposeE2eRemoteTerminalMultiplexAckGate(multiplexers)
  let multiplexer = multiplexers.get(environmentId)
  if (multiplexer && !multiplexer.matchesCurrentEnvironmentRevision()) {
    multiplexer.closeForEnvironmentReplacement()
    multiplexer = undefined
  }
  if (!multiplexer) {
    multiplexer = new RemoteRuntimeTerminalMultiplexer(
      environmentId,
      getRuntimeEnvironmentRevision(environmentId),
      releaseRemoteRuntimeTerminalMultiplexer
    )
    multiplexers.set(environmentId, multiplexer)
  }
  return multiplexer
}

export function _getRemoteRuntimeTerminalMultiplexerCountForTest(): number {
  return multiplexers.size
}

export function resetRemoteRuntimeTerminalMultiplexersForTests(): void {
  multiplexers.clear()
  resetRemoteRuntimeTerminalE2eState()
}
