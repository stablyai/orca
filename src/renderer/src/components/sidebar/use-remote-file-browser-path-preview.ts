import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  isRemoteFileBrowserPathResolveTextTooLarge,
  isPathMode,
  parsePathInput,
  shouldDeferRemoteFileBrowserPasteResolve
} from './remote-file-browser-helpers'
import {
  committedPrefix,
  resolvePathInput as resolvePathInputAgainstListings,
  type PreviewState
} from './remote-file-browser-path-preview-resolver'
import type { FetchListing } from './use-remote-file-browser-listing'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

const PATH_DEBOUNCE_MS = 300

export type RemoteFileBrowserPathPreviewArgs = {
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
  fetchListing: FetchListing
  homePathRef: RefObject<string | null>
  inputRef: RefObject<HTMLInputElement | null>
  clearFileHint: () => void
  setFilter: Dispatch<SetStateAction<string>>
}

export type RemoteFileBrowserPathPreview = {
  preview: PreviewState | null
  handleInputChange: (raw: string) => void
  handleInputPaste: (e: ClipboardEvent<HTMLInputElement>) => void
  /** Escape: drop the preview and any pending resolve, keeping the committed-prefix marker. */
  discardPreview: () => void
  /** Navigation: drop the preview, pending resolve, and the committed-prefix fast-path marker. */
  resetPreviewForNavigation: () => void
  /** Detach: invalidate in-flight preview work and clear its timers. */
  cancelPreviewWork: () => void
  /** False while a typed path's directory part still waits on the resolve debounce. */
  previewMatchesInput: (raw: string) => boolean
}

export function useRemoteFileBrowserPathPreview({
  resolvedPath,
  pathFlavor,
  fetchListing,
  homePathRef,
  inputRef,
  clearFileHint,
  setFilter
}: RemoteFileBrowserPathPreviewArgs): RemoteFileBrowserPathPreview {
  // Keep typed preview separate so it cannot change the Select target before navigation commits.
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewGenRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: paste resolution runs next tick; closing the picker before then must cancel stale preview work.
  const pasteResolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Committed-path portion (through the final `/`) the preview reflects; if unchanged next keystroke, skip re-resolving.
  const lastCommittedPrefixRef = useRef<string>('')

  const resetPreviewForNavigation = useCallback(() => {
    setPreview(null)
    previewGenRef.current++
    lastCommittedPrefixRef.current = ''
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const discardPreview = useCallback(() => {
    setPreview(null)
    previewGenRef.current++
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const cancelPreviewWork = useCallback(() => {
    previewGenRef.current++
    for (const timerRef of [debounceTimerRef, pasteResolveTimerRef]) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  const resolvePathInput = useCallback(
    async (raw: string) => {
      await resolvePathInputAgainstListings({
        raw,
        resolvedPath,
        pathFlavor,
        fetchListing,
        homePathRef,
        previewGenRef,
        lastCommittedPrefixRef,
        setPreview
      })
    },
    [resolvedPath, fetchListing, pathFlavor, homePathRef]
  )

  // Resolve committed path changes remotely; filter-mode and trailing-filter edits stay local.
  const handleInputChange = useCallback(
    (raw: string) => {
      clearFileHint()
      setFilter(raw)

      if (isRemoteFileBrowserPathResolveTextTooLarge(raw)) {
        if (preview) {
          setPreview(null)
          previewGenRef.current++
        }
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        if (pasteResolveTimerRef.current) {
          clearTimeout(pasteResolveTimerRef.current)
          pasteResolveTimerRef.current = null
        }
        return
      }

      if (!isPathMode(raw, pathFlavor)) {
        // Leaving path mode immediately restores the committed directory.
        if (preview) {
          setPreview(null)
          previewGenRef.current++
        }
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        return
      }

      const parsed = parsePathInput(raw, pathFlavor)
      // An unchanged committed prefix needs only local filtering, without another directory read.
      if (
        parsed.mode === 'path' &&
        preview &&
        !preview.error &&
        !parsed.invalid &&
        committedPrefix(raw) === lastCommittedPrefixRef.current
      ) {
        // Allow local filter edits during loading; the committed path is unchanged.
        setPreview({ ...preview, filter: parsed.trailingFilter })
        return
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        resolvePathInput(raw)
      }, PATH_DEBOUNCE_MS)
    },
    [clearFileHint, preview, resolvePathInput, pathFlavor, setFilter]
  )

  const handleInputPaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      if (e.defaultPrevented) {
        return
      }
      if (shouldDeferRemoteFileBrowserPasteResolve(e.clipboardData.getData('text/plain'))) {
        return
      }
      // Defer immediate paste resolution one tick so onChange first commits the pasted input.
      if (pasteResolveTimerRef.current) {
        clearTimeout(pasteResolveTimerRef.current)
      }
      pasteResolveTimerRef.current = setTimeout(() => {
        pasteResolveTimerRef.current = null
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        const value = inputRef.current?.value ?? ''
        if (!isRemoteFileBrowserPathResolveTextTooLarge(value) && isPathMode(value, pathFlavor)) {
          resolvePathInput(value)
        }
      }, 0)
    },
    [resolvePathInput, pathFlavor, inputRef]
  )

  const previewMatchesInput = useCallback(
    (raw: string) => committedPrefix(raw) === lastCommittedPrefixRef.current,
    []
  )

  return {
    preview,
    handleInputChange,
    handleInputPaste,
    discardPreview,
    resetPreviewForNavigation,
    cancelPreviewWork,
    previewMatchesInput
  }
}
