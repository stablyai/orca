import type { OrchestrationCrewFrame } from './orchestration-crew'

export type MountedCrewProducer = {
  address: string
  subscribe: (party: string, emit: (frame: OrchestrationCrewFrame) => void) => () => void
  removeAddress: () => void
}

export type MountedCrewProducerModule = {
  createMountedCrewProducer: () => MountedCrewProducer
}
