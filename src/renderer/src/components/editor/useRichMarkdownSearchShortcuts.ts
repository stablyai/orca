import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import {
  isMarkdownPreviewFindShortcut,
  isMarkdownPreviewReplaceShortcut
} from './markdown-preview-search'

export function useRichMarkdownSearchShortcuts({
  closeSearch,
  isSearchOpen,
  openReplace,
  openSearch,
  rootRef,
  searchInputRef
}: {
  closeSearch: () => void
  isSearchOpen: boolean
  openReplace: () => void
  openSearch: () => void
  rootRef: RefObject<HTMLDivElement | null>
  searchInputRef: RefObject<HTMLInputElement | null>
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || isImeOwnedKeyboardEvent(event)) {
        return
      }

      const target = event.target
      const targetInsideEditor = target instanceof Node && root.contains(target)
      if (
        isMarkdownPreviewFindShortcut(event, getShortcutPlatform(), keybindings) &&
        targetInsideEditor
      ) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
        return
      }

      if (
        isMarkdownPreviewReplaceShortcut(event, getShortcutPlatform(), keybindings) &&
        targetInsideEditor
      ) {
        event.preventDefault()
        event.stopPropagation()
        openReplace()
        return
      }

      if (
        event.key === 'Escape' &&
        isSearchOpen &&
        (targetInsideEditor || target === searchInputRef.current)
      ) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
      }
    }

    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [closeSearch, isSearchOpen, keybindings, openReplace, openSearch, rootRef, searchInputRef])
}
