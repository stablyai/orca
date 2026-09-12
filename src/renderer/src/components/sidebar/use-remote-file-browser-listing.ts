import { useCallback, useRef, type RefObject } from 'react'
import { browseRuntimeServerDirectory } from '@/runtime/runtime-server-directory-browser'
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
  // Per-picker listing cache keyed by resolved path, so typing issues at most one remote call per committed segment.
  const listingCacheRef = useRef<Map<string, BrowseResult>>(new Map())
  // Resolved remote home, cached after the first browseDir('~'); anchors `~`/`~/...` without hardcoding a home dir.
  const homePathRef = useRef<string | null>(null)

  const fetchListing = useCallback(
    async (dirPath: string): Promise<BrowseResult> => {
      const cached = listingCacheRef.current.get(dirPath)
      if (cached) {
        return cached
      }
      const result = targetId
        ? await window.api.ssh.browseDir({ targetId, dirPath })
        : await browseRuntimeServerDirectory(
            requireRuntimeEnvironmentId(runtimeEnvironmentId),
            dirPath
          )
      listingCacheRef.current.set(result.resolvedPath, result)
      // Also key by the requested dirPath (e.g. `~`, relative) so an identical request doesn't re-hit the SSH backend.
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
