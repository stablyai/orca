import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { stepRemoteFileBrowserHighlight } from './remote-file-browser-highlight'
import type { FetchListing } from './use-remote-file-browser-listing'
import {
  remoteFileBrowserProjectFolders,
  type RemoteFileBrowserHost
} from './remote-file-browser-project-folders'

const NO_FOLDERS: readonly string[] = []

/** Opened away from ~, the browser never lists home, so folder rows would show full paths. */
export function useRemoteFileBrowserHomeAnchor(
  needed: boolean,
  fetchListing: FetchListing,
  homePathRef: RefObject<string | null>,
  setHomePath: (path: string) => void
): void {
  useEffect(() => {
    if (!needed || homePathRef.current !== null) {
      return
    }
    let cancelled = false
    // The listing cache keeps this result, so a later Home click costs nothing.
    fetchListing('~').then(
      (result) => {
        if (!cancelled && homePathRef.current === null) {
          homePathRef.current = result.resolvedPath
          setHomePath(result.resolvedPath)
        }
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [needed, fetchListing, homePathRef, setHomePath])
}

export function useRemoteFileBrowserProjectFolders(
  host: RemoteFileBrowserHost,
  currentPath: string,
  visible: boolean
): readonly string[] {
  const { targetId, runtimeEnvironmentId } = host
  // Why shallow: catalog refreshes replace repo rows; equal paths must keep the array, or the highlight resets.
  return useAppStore(
    useShallow((s) =>
      visible
        ? remoteFileBrowserProjectFolders(s.repos, { targetId, runtimeEnvironmentId }, currentPath)
        : NO_FOLDERS
    )
  )
}

type ProjectFolderKeyArgs = {
  projectFolders: readonly string[]
  entryCount: number
  /** Index across the folder rows followed by the entry rows. */
  activeIndex: number
  moveHighlight: (index: number) => void
  navigate: (dirPath: string) => void
  handleEntryKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}

/** Arrows cross from the entry rows into the folder rows above them; Enter opens a folder row. */
export function useRemoteFileBrowserProjectFolderKeys({
  projectFolders,
  entryCount,
  activeIndex,
  moveHighlight,
  navigate,
  handleEntryKeyDown
}: ProjectFolderKeyArgs): (e: KeyboardEvent<HTMLInputElement>) => void {
  return useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      const folder = projectFolders[activeIndex]
      // Entry rows open on Enter with any modifier, so a highlighted folder must claim every Enter.
      if (e.key === 'Enter' && folder !== undefined && !isImeOwnedKeyboardEvent(e)) {
        e.preventDefault()
        navigate(folder)
        return
      }
      const modified = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey
      if (projectFolders.length > 0 && !modified && !isImeOwnedKeyboardEvent(e)) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const delta = e.key === 'ArrowDown' ? 1 : -1
          moveHighlight(
            stepRemoteFileBrowserHighlight(activeIndex, delta, projectFolders.length + entryCount)
          )
          return
        }
      }
      handleEntryKeyDown(e)
    },
    [projectFolders, entryCount, activeIndex, moveHighlight, navigate, handleEntryKeyDown]
  )
}
