import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  joinPath,
  parentPath,
  parsePathInput,
  resolveSegmentStep,
  type DirEntry
} from './remote-file-browser-helpers'
import type { FetchListing } from './use-remote-file-browser-listing'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

export type PreviewState = {
  resolvedPath: string
  entries: DirEntry[]
  filter: string
  error: string | null
  loading: boolean
}

export type ResolvePathInputArgs = {
  raw: string
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
  fetchListing: FetchListing
  homePathRef: RefObject<string | null>
  previewGenRef: RefObject<number>
  lastCommittedPrefixRef: RefObject<string>
  setPreview: Dispatch<SetStateAction<PreviewState | null>>
}

// Resolve a path-mode input into preview state; publishes intermediate loading/error states as it walks.
export async function resolvePathInput({
  raw,
  resolvedPath,
  pathFlavor,
  fetchListing,
  homePathRef,
  previewGenRef,
  lastCommittedPrefixRef,
  setPreview
}: ResolvePathInputArgs): Promise<void> {
  const parsed = parsePathInput(raw, pathFlavor)
  if (parsed.mode !== 'path') {
    return
  }
  const gen = ++previewGenRef.current

  if (parsed.invalid) {
    setPreview({
      resolvedPath: resolvedPath,
      entries: [],
      filter: '',
      error: parsed.invalid,
      loading: false
    })
    return
  }

  // Pick the base path; `~` needs the resolved home, so fetch and cache it once before resolving.
  let basePath: string
  if (parsed.base === 'root') {
    basePath = '/'
  } else if (parsed.base === 'drive') {
    basePath = parsed.driveRoot ?? '/'
  } else if (parsed.base === 'home') {
    if (!homePathRef.current) {
      setPreview({
        resolvedPath: resolvedPath,
        entries: [],
        filter: '',
        error: null,
        loading: true
      })
      try {
        const home = await fetchListing('~')
        if (gen !== previewGenRef.current) {
          return
        }
        homePathRef.current = home.resolvedPath
      } catch (err) {
        if (gen !== previewGenRef.current) {
          return
        }
        setPreview({
          resolvedPath,
          entries: [],
          filter: '',
          error: err instanceof Error ? err.message : String(err),
          loading: false
        })
        return
      }
    }
    basePath = homePathRef.current!
  } else {
    basePath = resolvedPath
  }

  setPreview((prev) => ({
    resolvedPath: prev?.resolvedPath ?? basePath,
    entries: prev?.entries ?? [],
    filter: prev?.filter ?? '',
    error: null,
    loading: true
  }))

  let currentPath = basePath
  try {
    for (const segment of parsed.committedSegments) {
      const listing = await fetchListing(currentPath)
      if (gen !== previewGenRef.current) {
        return
      }
      const outcome = resolveSegmentStep(segment, currentPath, listing.entries)
      if (outcome.type === 'error') {
        setPreview({
          resolvedPath: currentPath,
          entries: listing.entries,
          filter: '',
          error: outcome.message,
          loading: false
        })
        return
      }
      if (outcome.type === 'stay') {
        if (segment === '..') {
          currentPath = parentPath(currentPath, listing.pathFlavor)
        }
        continue
      }
      currentPath = joinPath(currentPath, outcome.name, listing.pathFlavor)
    }

    const finalListing = await fetchListing(currentPath)
    if (gen !== previewGenRef.current) {
      return
    }
    lastCommittedPrefixRef.current = committedPrefix(raw)
    setPreview({
      resolvedPath: finalListing.resolvedPath,
      entries: finalListing.entries,
      filter: parsed.trailingFilter,
      error: null,
      loading: false
    })
  } catch (err) {
    if (gen !== previewGenRef.current) {
      return
    }
    setPreview({
      resolvedPath: currentPath,
      entries: [],
      filter: '',
      error: err instanceof Error ? err.message : String(err),
      loading: false
    })
  }
}

// Portion before the final separator; distinguishes filter-only edits from committed-path changes.
export function committedPrefix(raw: string): string {
  const i = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return i === -1 ? '' : raw.slice(0, i + 1)
}
