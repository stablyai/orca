import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import type { DirEntry, HostDirectoryListing } from '../../../../shared/filesystem-entry-types'
import { joinPath, parentPath } from '../sidebar/remote-file-browser-helpers'
import {
  fetchHostDirectoryListing,
  planHostFileOpen,
  resolveHostEntry,
  type HostBrowseSource
} from './file-explorer-host-mode'
import { openHostFile } from './file-explorer-host-open'

// Why: local listings land in a few ms; a spinner that short reads as a glitch (STYLEGUIDE UX rule 1).
const HOST_LOADING_SHOW_DELAY_MS = 200
// Why: once shown, a spinner that vanishes a few ms later flickers just the same.
const HOST_LOADING_MIN_VISIBLE_MS = 400

export type FileExplorerHostBrowser = {
  listing: HostDirectoryListing | null
  loading: boolean
  /** `loading` once it has outlasted HOST_LOADING_SHOW_DELAY_MS, held for HOST_LOADING_MIN_VISIBLE_MS; drives visible spinners. */
  showLoading: boolean
  error: string | null
  canNavigateUp: boolean
  navigate: (dirPath: string) => void
  navigateUp: () => void
  refresh: () => void
  activateEntry: (entry: DirEntry) => void
}

type HostBrowserSession = {
  key: string
  listing: HostDirectoryListing | null
  error: string | null
  pendingPath: string | null
}

/** One browsing session per Host visit; `visitKey` is null outside Host mode. */
export function useFileExplorerHostBrowser({
  visitKey: sessionKey,
  source,
  worktreeId,
  worktreePath
}: {
  visitKey: string | null
  source: HostBrowseSource | null
  worktreeId: string | null
  worktreePath: string | null
}): FileExplorerHostBrowser {
  const [session, setSession] = useState<HostBrowserSession | null>(null)
  const current = session && session.key === sessionKey ? session : null
  // Why: breadcrumb clicks race over SSH exec channels; only the latest request may land.
  const listingGenerationRef = useRef(0)
  const activationGenerationRef = useRef(0)
  // Why: source objects are rebuilt each render; requests only need the latest host.
  const sourceRef = useRef(source)
  sourceRef.current = source
  const sessionRef = useRef(session)
  sessionRef.current = session

  const startListing = useCallback((key: string, dirPath: string, generation: number) => {
    const source = sourceRef.current
    if (!source) {
      return
    }
    void fetchHostDirectoryListing(source, dirPath).then(
      (next) => {
        if (generation === listingGenerationRef.current) {
          setSession({ key, listing: next, error: null, pendingPath: null })
        }
      },
      (err: unknown) => {
        if (generation !== listingGenerationRef.current) {
          return
        }
        const message = extractIpcErrorMessage(err, 'Unknown error')
        const previous = sessionRef.current
        if (previous?.key === key && previous.listing) {
          // Why: like Finder/MobaXterm, an unopenable folder leaves you where you were.
          setSession({ ...previous, pendingPath: null })
          toast.error(
            translate(
              'fileExplorer.host.folderOpenFailed',
              'Could not open this folder: {{error}}',
              {
                error: message
              }
            )
          )
          return
        }
        setSession({ key, listing: null, error: message, pendingPath: null })
      }
    )
  }, [])

  useEffect(() => {
    const generation = ++listingGenerationRef.current
    activationGenerationRef.current++
    if (sessionKey && worktreePath) {
      startListing(sessionKey, worktreePath, generation)
    }
  }, [sessionKey, startListing, worktreePath])

  const navigate = useCallback(
    (dirPath: string) => {
      if (!sessionKey) {
        return
      }
      const generation = ++listingGenerationRef.current
      // Why: a slow click resolution must not pull the user back after they navigated away.
      activationGenerationRef.current++
      setSession((prev) =>
        prev?.key === sessionKey
          ? { ...prev, pendingPath: dirPath }
          : { key: sessionKey, listing: null, error: null, pendingPath: dirPath }
      )
      startListing(sessionKey, dirPath, generation)
    },
    [sessionKey, startListing]
  )

  const listing = current?.listing ?? null
  const loading = sessionKey !== null && (current === null || current.pendingPath !== null)
  const [shownLoadingKey, setShownLoadingKey] = useState<string | null>(null)
  const shownLoadingAtRef = useRef(0)
  useEffect(() => {
    if (sessionKey === null) {
      setShownLoadingKey(null)
      return
    }
    if (loading) {
      if (shownLoadingKey === sessionKey) {
        return
      }
      const timer = setTimeout(() => {
        shownLoadingAtRef.current = Date.now()
        setShownLoadingKey(sessionKey)
      }, HOST_LOADING_SHOW_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (shownLoadingKey === null) {
      return
    }
    if (shownLoadingKey !== sessionKey) {
      setShownLoadingKey(null)
      return
    }
    const remaining = HOST_LOADING_MIN_VISIBLE_MS - (Date.now() - shownLoadingAtRef.current)
    const timer = setTimeout(() => setShownLoadingKey(null), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [loading, sessionKey, shownLoadingKey])
  const showLoading = sessionKey !== null && shownLoadingKey === sessionKey
  const currentPath = listing?.resolvedPath ?? null
  const parent = currentPath ? parentPath(currentPath, listing?.pathFlavor ?? 'posix') : null
  const canNavigateUp = !loading && currentPath !== null && parent !== currentPath

  const navigateUp = useCallback(() => {
    if (canNavigateUp && parent) {
      navigate(parent)
    }
  }, [canNavigateUp, navigate, parent])

  const refresh = useCallback(() => {
    const target = currentPath ?? worktreePath
    if (target) {
      navigate(target)
    }
  }, [currentPath, navigate, worktreePath])

  const activateEntry = useCallback(
    (entry: DirEntry) => {
      if (!source || !listing || !worktreeId || !worktreePath) {
        return
      }
      const entryPath = joinPath(listing.resolvedPath, entry.name, listing.pathFlavor)
      const generation = ++activationGenerationRef.current
      void resolveHostEntry(source, entryPath, entry, worktreePath).then(
        (resolution) => {
          if (generation !== activationGenerationRef.current) {
            return
          }
          if (resolution.kind === 'directory') {
            navigate(entryPath)
            return
          }
          if (resolution.kind === 'unsupported') {
            toast.error(
              translate('fileExplorer.host.unsupportedEntry', 'This item cannot be opened.')
            )
            return
          }
          openHostFile({
            plan: planHostFileOpen({
              worktreePath,
              entryPath,
              workspaceRelativePath: resolution.workspaceRelativePath
            }),
            source,
            worktreeId
          })
        },
        (err: unknown) => {
          if (generation !== activationGenerationRef.current) {
            return
          }
          // Why: loss of contact with the host is not evidence the file is gone.
          toast.error(
            isMissingRuntimePathError(err)
              ? translate('fileExplorer.host.entryMissing', 'This item no longer exists.')
              : translate(
                  'fileExplorer.host.entryUnverifiable',
                  'Could not reach this item: {{error}}',
                  { error: extractIpcErrorMessage(err, 'Unknown error') }
                )
          )
        }
      )
    },
    [listing, navigate, source, worktreeId, worktreePath]
  )

  const error = current?.error ?? null
  return useMemo(
    () => ({
      listing,
      loading,
      showLoading,
      error,
      canNavigateUp,
      navigate,
      navigateUp,
      refresh,
      activateEntry
    }),
    [
      listing,
      loading,
      showLoading,
      error,
      canNavigateUp,
      navigate,
      navigateUp,
      refresh,
      activateEntry
    ]
  )
}
