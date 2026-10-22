import {
  exposeE2eRemoteTerminalMultiplexAckGate,
  resetRemoteRuntimeTerminalE2eState
} from './remote-runtime-terminal-e2e-control'
import type { RemoteRuntimeTerminalMultiplexerBase } from './remote-runtime-terminal-multiplexer-base'
import { RemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer-implementation'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from './runtime-environment-revision'

const multiplexers = new Map<string, RemoteRuntimeTerminalMultiplexer>()

// Why: a removed or replaced machine's streams end for good, before its new revision is published.
onRuntimeEnvironmentsRetired((environmentIds) => {
  for (const environmentId of environmentIds) {
    multiplexers.get(environmentId)?.closeForEnvironmentRetirement()
  }
})

// Why: a stream opened before main re-paired stays open but sendFrame refuses its stale revision,
// so input would vanish silently; a recoverable close lets each pane rebind, and the pane itself
// only follows the new pairing once it is proven to be the same machine.
onRuntimeEnvironmentRevisionsChanged((environmentIds) => {
  for (const environmentId of environmentIds) {
    const multiplexer = multiplexers.get(environmentId)
    if (multiplexer && !multiplexer.matchesCurrentEnvironmentRevision()) {
      multiplexer.closeForEnvironmentReplacement()
    }
  }
})

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
