import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import type { FilesystemPathFlavor } from '../../../../../shared/file-access/filesystem-path-flavor'
import { sortDirEntries } from '../../../../../shared/file-listing/file-name-sort'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'

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
