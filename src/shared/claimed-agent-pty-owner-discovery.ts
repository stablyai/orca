import type { AgentSessionOwnerBinding } from './agent-session-host-authority'

type DiscoveredProcess = NonNullable<AgentSessionOwnerBinding['discoveryProcess']>

export function isSameDiscoveredProcess(
  left: DiscoveredProcess,
  right: DiscoveredProcess
): boolean {
  return (
    left.ptyIncarnationId === right.ptyIncarnationId &&
    left.pid === right.pid &&
    left.startTime === right.startTime
  )
}

function isNewerProviderObservation(
  previous: DiscoveredProcess['providerObservation'],
  next: DiscoveredProcess['providerObservation']
): boolean {
  if (!previous || !next) {
    return false
  }
  if (previous.authorityId !== next.authorityId) {
    return true
  }
  return (
    next.incarnation > previous.incarnation ||
    (next.incarnation === previous.incarnation && next.revision > previous.revision)
  )
}

export function canReplaceDiscoveredProcess(
  previous: DiscoveredProcess,
  next: DiscoveredProcess
): boolean {
  return (
    canRetireDiscoveredProcessFromObservation(previous, next) &&
    isNewerProviderObservation(previous.providerObservation, next.providerObservation)
  )
}

export function canRetireDiscoveredProcessFromObservation(
  process: DiscoveredProcess,
  observation: { authorityGeneration: string; observationEpoch: number }
): boolean {
  return (
    process.authorityGeneration !== observation.authorityGeneration ||
    process.observationEpoch <= observation.observationEpoch
  )
}
