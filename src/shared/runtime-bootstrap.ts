import { join } from 'path'

export type RuntimeTransportMetadata =
  | {
      kind: 'unix'
      endpoint: string
    }
  | {
      kind: 'named-pipe'
      endpoint: string
    }

export type RuntimeMetadata = {
  runtimeId: string
  pid: number
  transport: RuntimeTransportMetadata | null
  authToken: string | null
  startedAt: number
}

const PRIMARY_RUNTIME_METADATA_FILE = 'orca-runtime.json'
const RUNTIME_RECORD_PREFIX = 'orca-runtime-'
const RUNTIME_RECORD_SUFFIX = '.json'

export function getRuntimeMetadataPath(userDataPath: string): string {
  return join(userDataPath, PRIMARY_RUNTIME_METADATA_FILE)
}

export function getRuntimeRecordPath(userDataPath: string, runtimeId: string): string {
  return join(userDataPath, `${RUNTIME_RECORD_PREFIX}${runtimeId}${RUNTIME_RECORD_SUFFIX}`)
}

export function isRuntimeRecordFileName(fileName: string): boolean {
  return (
    fileName.startsWith(RUNTIME_RECORD_PREFIX) &&
    fileName.endsWith(RUNTIME_RECORD_SUFFIX) &&
    fileName !== PRIMARY_RUNTIME_METADATA_FILE
  )
}
