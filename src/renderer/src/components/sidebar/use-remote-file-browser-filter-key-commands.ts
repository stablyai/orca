import { useCallback, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react'
import {
  decideEnterAction,
  decideEscAction,
  filterEntries,
  joinPath,
  parsePathInput,
  type DirEntry
} from './remote-file-browser-helpers'
import type { PreviewState } from './remote-file-browser-path-preview-resolver'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

export type RemoteFileBrowserFilterKeyCommandsArgs = {
  filter: string
  setFilter: Dispatch<SetStateAction<string>>
  filteredEntries: DirEntry[]
  preview: PreviewState | null
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
  filter,
  setFilter,
  filteredEntries,
  preview,
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
      if (e.key === 'Enter') {
        if (preview) {
          // Path mode Enter.
          if (preview.error || preview.loading) {
            e.preventDefault()
            return
          }
          const parsed = parsePathInput(filter, pathFlavor)
          // Fully-resolved directory (trailing `/` or bare base marker): navigate to the preview path itself.
          if (parsed.mode === 'path' && parsed.trailingFilter === '') {
            e.preventDefault()
            navigate(preview.resolvedPath)
            return
          }
          // Trailing filter: resolve to a single folder match in the preview listing, mirroring filter-mode Enter.
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
        // Backspace in an empty input climbs to the parent; in-word backspaces are untouched.
        if (resolvedPath !== '/') {
          e.preventDefault()
          navigateUp()
        }
      }
    },
    [
      filter,
      filteredEntries,
      preview,
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
