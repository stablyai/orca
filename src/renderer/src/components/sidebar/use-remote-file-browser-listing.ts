import { useCallback, useRef, type RefObject } from 'react'
import { browseRuntimeServerDirectory } from '@/runtime/runtime-server-directory-browser'
import { browseRuntimeSshDirectory } from '@/runtime/runtime-ssh-target-management'
import type { DirEntry } from './remote-file-browser-helpers'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

export type BrowseResult = {
  resolvedPath: string
  entries: DirEntry[]
  pathFlavor: FilesystemPathFlavor
}

export type FetchListing = (dirPath: string) => Promise<BrowseResult>

export type RemoteFileBrowserListing = {
  fetchListing: FetchListing
  homePathRef: RefObject<string | null>
}

export function useRemoteFileBrowserListing(
  targetId: string | undefined,
  runtimeEnvironmentId: string | undefined
): RemoteFileBrowserListing {
  // Cache listings per picker so repeated segment resolution can reuse successful remote reads.
  const listingCacheRef = useRef<Map<string, BrowseResult>>(new Map())
  // Resolve the remote home once rather than guessing a host path.
  const homePathRef = useRef<string | null>(null)

  const fetchListing = useCallback(
    async (dirPath: string): Promise<BrowseResult> => {
      const cached = listingCacheRef.current.get(dirPath)
      if (cached) {
        return cached
      }
      // Why: with both set, the target is the server's own SSH host and only the server dials it.
      const result =
        targetId && runtimeEnvironmentId
          ? await browseRuntimeSshDirectory(runtimeEnvironmentId, targetId, dirPath)
          : targetId
            ? await window.api.ssh.browseDir({ targetId, dirPath })
            : await browseRuntimeServerDirectory(
                requireRuntimeEnvironmentId(runtimeEnvironmentId),
                dirPath
              )
      listingCacheRef.current.set(result.resolvedPath, result)
      // Cache requested aliases too so repeated home/relative requests reuse the resolved listing.
      if (dirPath !== result.resolvedPath) {
        listingCacheRef.current.set(dirPath, result)
      }
      return result
    },
    [runtimeEnvironmentId, targetId]
  )

  return { fetchListing, homePathRef }
}

function requireRuntimeEnvironmentId(runtimeEnvironmentId: string | undefined): string {
  if (!runtimeEnvironmentId) {
    throw new Error('Runtime environment is required')
  }
  return runtimeEnvironmentId
}
