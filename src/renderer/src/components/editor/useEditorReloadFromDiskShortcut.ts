import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { canReloadTabFromDisk, reloadTabContentFromDisk } from './ExternalFileChangeBanner'

type UseEditorReloadFromDiskShortcutParams = {
  activeFile: OpenFile | null
  panelRef: RefObject<HTMLDivElement | null>
  reloadContent: (file: OpenFile) => void
}

export function useEditorReloadFromDiskShortcut({
  activeFile,
  panelRef,
  reloadContent
}: UseEditorReloadFromDiskShortcutParams): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useEffect(() => {
    if (!activeFile || !canReloadTabFromDisk(activeFile)) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.repeat ||
        event.defaultPrevented ||
        !keybindingMatchesAction('editor.reloadFromDisk', event, getShortcutPlatform(), keybindings)
      ) {
        return
      }
      // Why: scope to this panel so a split's inactive editor cannot swallow the chord.
      const root = panelRef.current
      const target = event.target
      if (!root || !(target instanceof Node) || !root.contains(target)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      reloadTabContentFromDisk(activeFile, reloadContent)
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeFile, keybindings, panelRef, reloadContent])
}
