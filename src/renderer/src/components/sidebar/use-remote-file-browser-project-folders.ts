import { useCallback, useMemo, type KeyboardEvent } from 'react'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { stepRemoteFileBrowserHighlight } from './remote-file-browser-highlight'
import {
  remoteFileBrowserProjectFolders,
  type RemoteFileBrowserHost
} from './remote-file-browser-project-folders'

const NO_FOLDERS: readonly string[] = []

export function useRemoteFileBrowserProjectFolders(
  host: RemoteFileBrowserHost,
  currentPath: string,
  visible: boolean
): readonly string[] {
  const repos = useAppStore((s) => s.repos)
  const { targetId, runtimeEnvironmentId } = host
  return useMemo(
    () =>
      visible
        ? remoteFileBrowserProjectFolders(repos, { targetId, runtimeEnvironmentId }, currentPath)
        : NO_FOLDERS,
    [repos, targetId, runtimeEnvironmentId, currentPath, visible]
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
        const folder = projectFolders[activeIndex]
        if (e.key === 'Enter' && folder !== undefined) {
          e.preventDefault()
          navigate(folder)
          return
        }
      }
      handleEntryKeyDown(e)
    },
    [projectFolders, entryCount, activeIndex, moveHighlight, navigate, handleEntryKeyDown]
  )
}
