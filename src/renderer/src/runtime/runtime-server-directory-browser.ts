import type { DirEntry } from '../../../shared/types'
import { callRuntimeRpc } from './runtime-rpc-client'

export type RuntimeServerDirectoryListing = {
  resolvedPath: string
  entries: DirEntry[]
}

export async function browseRuntimeServerDirectory(
  environmentId: string,
  path: string
): Promise<RuntimeServerDirectoryListing> {
  return callRuntimeRpc<RuntimeServerDirectoryListing>(
    { kind: 'environment', environmentId },
    'files.browseServerDir',
    { path },
    { timeoutMs: 15_000 }
  )
}

/** Browse an SSH target through the paired runtime environment that owns it. */
export async function browseRuntimeSshDirectory(
  environmentId: string,
  targetId: string,
  dirPath: string
): Promise<RuntimeServerDirectoryListing> {
  return callRuntimeRpc<RuntimeServerDirectoryListing>(
    { kind: 'environment', environmentId },
    'ssh.browseDir',
    { targetId, dirPath },
    { timeoutMs: 15_000 }
  )
}
