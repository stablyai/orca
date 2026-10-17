import { useEffect, useRef, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { shouldIgnoreFileExplorerKeyTarget } from './useFileExplorerKeys'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import type { useFileExplorerImagePaste } from './use-file-explorer-image-paste'

export function useFileExplorerPasteEvents(opts: {
  containerRef: RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  selectedNode: TreeNode | null
  isEditing: boolean
  imagePaste: ReturnType<typeof useFileExplorerImagePaste>
}): void {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const explorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const current = useRef(opts)
  current.current = opts

  useEffect(() => {
    if (!rightSidebarOpen || rightSidebarTab !== 'explorer' || explorerView !== 'files') {
      return
    }
    let suppressionTimer: number | undefined
    const onPaste = (event: Event): void => {
      const { containerRef, rowProjection, selectedNode, isEditing, imagePaste } = current.current
      const active = document.activeElement
      if (
        event.defaultPrevented ||
        isEditing ||
        (!imagePaste.canPasteImage && !imagePaste.isPastingImage) ||
        !active ||
        !containerRef.current?.contains(active) ||
        shouldIgnoreFileExplorerKeyTarget(active) ||
        shouldIgnoreFileExplorerKeyTarget(event.target)
      ) {
        return
      }
      if (event instanceof KeyboardEvent) {
        const modifier =
          getShortcutPlatform() === 'darwin'
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey
        if (
          !modifier ||
          event.key.toLowerCase() !== 'v' ||
          event.altKey ||
          event.shiftKey ||
          event.isComposing
        ) {
          return
        }
      }
      event.preventDefault()
      event.stopPropagation()
      if (suppressionTimer !== undefined || (event instanceof KeyboardEvent && event.repeat)) {
        return
      }
      // Electron may deliver keydown, menu and DOM paste for the same gesture.
      suppressionTimer = window.setTimeout(() => {
        suppressionTimer = undefined
      }, 0)
      const wrapper = active.closest<HTMLElement>('[data-index]')
      const focusedNode =
        wrapper?.dataset.index !== undefined
          ? rowProjection.getRowAtIndex(Number(wrapper.dataset.index))
          : null
      void imagePaste.pasteImage(focusedNode ?? selectedNode)
    }
    window.addEventListener('keydown', onPaste, true)
    window.addEventListener('paste', onPaste, true)
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)
    return () => {
      window.clearTimeout(suppressionTimer)
      window.removeEventListener('keydown', onPaste, true)
      window.removeEventListener('paste', onPaste, true)
      window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
    }
  }, [rightSidebarOpen, rightSidebarTab, explorerView])
}
