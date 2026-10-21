import { type KeyboardEvent, useCallback, useEffect, useId, useRef } from 'react'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'
import { copyImageToClipboard } from '@/lib/copy-image-to-clipboard'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isWebClientLocation } from '@/lib/web-client-location'

const COPY_SCOPE_ATTRIBUTE = 'data-image-viewer-copy-scope'

function isFocusInScope(scopeId: string): boolean {
  const scope = document.activeElement?.closest(`[${COPY_SCOPE_ATTRIBUTE}]`)
  return scope?.getAttribute(COPY_SCOPE_ATTRIBUTE) === scopeId
}

function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0
}

export type ImageViewerCopy = {
  /** Undefined when this client can't write images to the clipboard. */
  copyImage: (() => void) | undefined
  /** Spread on every element whose focus should make Cmd/Ctrl+C copy the image. */
  copyScopeProps: {
    [COPY_SCOPE_ATTRIBUTE]: string
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  }
}

export function useImageViewerCopy(src: string | null): ImageViewerCopy {
  const scopeId = useId()
  // The web client's image clipboard write is a no-op.
  const canCopy = src !== null && !isWebClientLocation()

  const isCopyingRef = useRef(false)

  const copyImage = useCallback(() => {
    if (!src || isCopyingRef.current) {
      return
    }
    isCopyingRef.current = true
    void copyImageToClipboard(async () => (await fetch(src)).blob()).finally(() => {
      isCopyingRef.current = false
    })
  }, [src])

  useEffect(() => {
    if (!canCopy) {
      return
    }
    // Why: on macOS Cmd+C is an app-menu accelerator, so it arrives as a menu action, not a keydown.
    const onSelectionAction = (event: Event): void => {
      if (
        !(event instanceof CustomEvent) ||
        event.detail !== 'copy' ||
        !isFocusInScope(scopeId) ||
        hasTextSelection()
      ) {
        return
      }
      event.preventDefault()
      copyImage()
    }
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
    return () => window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
  }, [canCopy, copyImage, scopeId])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        !canCopy ||
        getShortcutPlatform() === 'darwin' ||
        event.repeat ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        // Why: match the physical key so Ctrl+C works on non-Latin layouts, like the terminal does.
        event.code !== 'KeyC' ||
        hasTextSelection()
      ) {
        return
      }
      event.preventDefault()
      copyImage()
    },
    [canCopy, copyImage]
  )

  return {
    copyImage: canCopy ? copyImage : undefined,
    copyScopeProps: { [COPY_SCOPE_ATTRIBUTE]: scopeId, onKeyDown }
  }
}
