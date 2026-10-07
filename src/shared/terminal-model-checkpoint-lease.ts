export type TerminalModelCheckpointLease = {
  version: 1
  leaseId: string
  ptyId: string
  incarnationId?: string
  sourceSeq: number
  metadataByteLength: number
  byteLength: number
}

export type TerminalModelCheckpointResourceWindow = {
  leaseId: string
  /** Null selects the UTF-8 metadata; image resource ids are never paths. */
  resourceId: number | null
  offset: number
  length: number
}

export type TerminalModelCheckpointTransport = {
  captureModelCheckpoint: (
    id: string,
    expectedIncarnationId: string
  ) => Promise<TerminalModelCheckpointLease | null>
  readModelCheckpoint: (
    id: string,
    window: TerminalModelCheckpointResourceWindow
  ) => Promise<Uint8Array>
  releaseModelCheckpoint: (id: string, leaseId: string) => Promise<boolean>
}
