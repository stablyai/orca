import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  type FileExplorerDirectoryListing
} from './file-explorer-directory-listing'

export type RefreshFileExplorerTreeDir = {
  dirPath: string
  depth: number
}

export type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  readDirectory: (dirPath: string) => Promise<FileExplorerDirectoryListing>
  maxConcurrentReads: number
  /** Called per dir whose fresh listing was committed, so callers can clear a staleness mark. */
  onDirCommitted?: (dirPath: string) => void
}

export async function refreshFileExplorerExpandedDirs({
  dirs,
  worktreePath,
  dirLoadTracker,
  setDirCache,
  readDirectory,
  maxConcurrentReads,
  onDirCommitted
}: RefreshFileExplorerExpandedDirsParams): Promise<boolean> {
  if (dirs.length === 0) {
    return true
  }

  const uniqueDirs = Array.from(new Map(dirs.map((dir) => [dir.dirPath, dir])).values())
  // Why: begin every token before the first read so a concurrent refreshDir or
  // worktree reset supersedes dirs still queued in a later wave, exactly as the
  // single-batch version did.
  const loadTokens = new Map(
    uniqueDirs.map((dir) => [dir.dirPath, dirLoadTracker.begin(dir.dirPath)])
  )
  const waveSize = Math.max(1, Math.floor(maxConcurrentReads))
  let committedDirs = 0

  // Why: mark every dir loading up front, not per wave — FileExplorer's auto-load
  // effect re-runs on any `expanded` change and fans out an unbounded loadDir per
  // dir that is neither cached nor loading, which would defeat the wave cap.
  setDirCache((prev) => {
    const next = { ...prev }
    for (const { dirPath } of uniqueDirs) {
      next[dirPath] = {
        children: prev[dirPath]?.children ?? [],
        loading: true
      }
    }
    return next
  })

  for (let start = 0; start < uniqueDirs.length; start += waveSize) {
    // Why: a dir superseded while an earlier wave was reading is left to its
    // newer load — reading it here would only burn a round trip for a result
    // that is dropped at commit time.
    const wave = uniqueDirs
      .slice(start, start + waveSize)
      .filter(({ dirPath }) => dirLoadTracker.isCurrent(loadTokens.get(dirPath)!))
    if (wave.length === 0) {
      continue
    }

    // Why: batch each wave's results into one setDirCache write, so the whole
    // refresh costs 1 + ceil(N / waveSize) cache spreads rather than one per dir.
    const results = await Promise.all(
      wave.map(async ({ dirPath, depth }) => {
        const loadToken = loadTokens.get(dirPath)!
        try {
          const listing = await readDirectory(dirPath)
          if (!dirLoadTracker.isCurrent(loadToken)) {
            return { current: false as const }
          }
          return {
            current: true as const,
            dirPath,
            cache: {
              children: fileExplorerEntriesToTreeNodes(
                listing.entries,
                dirPath,
                depth,
                worktreePath,
                listing.operationOwner
              ),
              loading: false,
              operationOwner: listing.operationOwner
            }
          }
        } catch {
          if (!dirLoadTracker.isCurrent(loadToken)) {
            return { current: false as const }
          }
          return {
            current: true as const,
            dirPath,
            cache: { children: [], loading: false }
          }
        }
      })
    )

    // Why: the batch commits only after the slowest read in the wave, so a dir
    // can be superseded (watcher refreshDir, worktree reset) after its own read
    // resolved. Re-check tokens at commit time so the batched write never
    // clobbers a newer load — preserving the old per-dir commit ordering.
    const currentResults = results.filter(
      (result): result is Extract<typeof result, { current: true }> =>
        result.current && dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!)
    )
    if (currentResults.length === 0) {
      continue
    }

    setDirCache((prev) => {
      const next = { ...prev }
      for (const result of currentResults) {
        next[result.dirPath] = result.cache
      }
      return next
    })
    for (const result of currentResults) {
      onDirCommitted?.(result.dirPath)
    }
    committedDirs += currentResults.length
  }

  return committedDirs === uniqueDirs.length
}
