export const LOCAL_LOG_TAIL_CHUNK_BYTES = 256 * 1024

export type LocalLogTailReadArgs = {
  filePath: string
  fromByteOffset: number
  expectedIdentity?: string
}

export type LocalLogTailReadResult = {
  contentBase64: string
  nextByteOffset: number
  fileSize: number
  fileIdentity: string
  hasMore: boolean
  reset: boolean
}

export type LocalLogTailWatchArgs = {
  filePath: string
  subscriptionId: string
}

export type LocalLogTailChangedPayload = {
  subscriptionId: string
  eventType: 'change' | 'rename'
}
