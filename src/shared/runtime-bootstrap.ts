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

export function getRuntimeMetadataPath(userDataPath: string): string {
  return join(userDataPath, PRIMARY_RUNTIME_METADATA_FILE)
}
