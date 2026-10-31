import type { OrchestrationCrewFrame } from './orchestration-crew'

export type MountedCrewProducer = {
  address: string
  metrics: { reads: number; acquisitions: number; frames: number; snapshotSerializations: number }
  subscribe: (party: string, emit: (frame: OrchestrationCrewFrame) => void) => () => void
  removeAddress: () => void
  restoreAddress: () => void
  equalOwnerWake: () => void
}

export type MountedCrewProducerModule = {
  createMountedCrewProducer: () => MountedCrewProducer
}
