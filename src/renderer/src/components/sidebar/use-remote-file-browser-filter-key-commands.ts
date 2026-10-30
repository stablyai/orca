import { useCallback, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  joinPath,
  parsePathInput,
  type DirEntry
} from './remote-file-browser-helpers'
import { stepRemoteFileBrowserHighlight } from './remote-file-browser-highlight'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { PreviewState } from './remote-file-browser-path-preview-resolver'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

export type RemoteFileBrowserFilterKeyCommandsArgs = {
  loading: boolean
  filter: string
  setFilter: Dispatch<SetStateAction<string>>
  filteredEntries: DirEntry[]
  displayEntries: readonly DirEntry[]
  activeIndex: number
  moveHighlight: (index: number) => void
  listParentPath: string
  preview: PreviewState | null
  previewMatchesInput: (raw: string) => boolean
  discardPreview: () => void
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
  navigate: (dirPath: string) => void
  navigateInto: (name: string) => void
  navigateUp: () => void
  triggerFileHint: () => void
  clearFileHint: () => void
  onCancel: () => void
}

export function useRemoteFileBrowserFilterKeyCommands({
  loading,
  filter,
  setFilter,
  filteredEntries,
  displayEntries,
  activeIndex,
  moveHighlight,
  listParentPath,
  preview,
  previewMatchesInput,
  discardPreview,
  resolvedPath,
  pathFlavor,
  navigate,
  navigateInto,
  navigateUp,
  triggerFileHint,
  clearFileHint,
  onCancel
}: RemoteFileBrowserFilterKeyCommandsArgs): (e: KeyboardEvent<HTMLInputElement>) => void {
  return useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      const modified = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey
      if (
        (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        !modified &&
        !isImeOwnedKeyboardEvent(e)
      ) {
        if (displayEntries.length > 0 && !preview?.loading) {
          e.preventDefault()
          const delta = e.key === 'ArrowDown' ? 1 : -1
          moveHighlight(stepRemoteFileBrowserHighlight(activeIndex, delta, displayEntries.length))
        }
        return
      }
      if (e.key === 'Enter') {
        // Why: until the debounce resolves typed path input, the rows on screen belong to another directory.
        const pathPending =
          parsePathInput(filter, pathFlavor).mode === 'path' &&
          (!preview || !previewMatchesInput(filter))
        if (preview?.error || preview?.loading || pathPending) {
          e.preventDefault()
          return
        }
        const highlighted = displayEntries[activeIndex]
        if (highlighted) {
          e.preventDefault()
          if (highlighted.isDirectory) {
            navigate(joinPath(listParentPath, highlighted.name, pathFlavor))
          } else {
            triggerFileHint()
          }
          return
        }
        if (preview) {
          const parsed = parsePathInput(filter, pathFlavor)
          // Without a trailing filter, commit the resolved preview directory itself.
          if (parsed.mode === 'path' && parsed.trailingFilter === '') {
            e.preventDefault()
            navigate(preview.resolvedPath)
            return
          }
          // Resolve the trailing filter with the same unique-folder rule as normal Enter.
          const filtered = filterEntries(preview.entries, preview.filter)
          const action = decideEnterAction(filtered)
          if (action.type === 'navigate') {
            e.preventDefault()
            navigate(joinPath(preview.resolvedPath, action.name, pathFlavor))
          } else if (action.type === 'fileHint') {
            e.preventDefault()
            triggerFileHint()
          } else {
            e.preventDefault()
          }
          return
        }
        // Why: while the next listing loads, filteredEntries still holds the previous directory.
        if (loading) {
          e.preventDefault()
          return
        }
        const action = decideEnterAction(filteredEntries)
        if (action.type === 'navigate') {
          e.preventDefault()
          navigateInto(action.name)
        } else if (action.type === 'fileHint') {
          e.preventDefault()
          triggerFileHint()
        }
        return
      }
      if (e.key === 'Escape') {
        const action = decideEscAction(filter)
        if (action.type === 'clearFilter') {
          e.stopPropagation()
          e.preventDefault()
          setFilter('')
          discardPreview()
          clearFileHint()
        } else {
          onCancel()
        }
      }
      if (e.key === 'Backspace' && filter === '' && !preview) {
        if (resolvedPath !== '/') {
          e.preventDefault()
          navigateUp()
        }
      }
    },
    [
      loading,
      filter,
      filteredEntries,
      displayEntries,
      activeIndex,
      moveHighlight,
      listParentPath,
      preview,
      previewMatchesInput,
      navigate,
      navigateInto,
      navigateUp,
      resolvedPath,
      triggerFileHint,
      clearFileHint,
      onCancel,
      pathFlavor,
      setFilter,
      discardPreview
    ]
  )
}
