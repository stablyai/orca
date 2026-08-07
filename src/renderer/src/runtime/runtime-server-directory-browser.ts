import type { DirEntry, FilesystemPathFlavor } from '../../../shared/types'
import { sortDirEntries } from '../../../shared/file-name-sort'
import { callRuntimeRpc } from './runtime-rpc-client'

export type RuntimeServerDirectoryListing = {
  resolvedPath: string
  entries: DirEntry[]
  pathFlavor: FilesystemPathFlavor
}

export async function browseRuntimeServerDirectory(
  environmentId: string,
  path: string
): Promise<RuntimeServerDirectoryListing> {
  const listing = await callRuntimeRpc<RuntimeServerDirectoryListing>(
    { kind: 'environment', environmentId },
    'files.browseServerDir',
    { path },
    { timeoutMs: 15_000 }
  )
  return { ...listing, entries: sortDirEntries(listing.entries) }
}
