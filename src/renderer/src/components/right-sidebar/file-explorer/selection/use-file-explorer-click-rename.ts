import { useEffect, useRef } from 'react'
import type React from 'react'
import { useAppStore } from '@/store/index'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type { TreeNode } from '../tree/file-explorer-types'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'

/**
 * A file click hands focus to the opened editor, so the explorer's own key handler never sees
 * the next key. The rename chord pressed right after a row click still renames that row.
 */
export function useFileExplorerClickRename(opts: {
  containerRef: React.RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  startRename: (node: TreeNode) => void
}): void {
  const keybindings = useAppStore((s) => s.keybindings)
  const rowProjectionRef = useRef(opts.rowProjection)
  rowProjectionRef.current = opts.rowProjection
  const startRenameRef = useRef(opts.startRename)
  startRenameRef.current = opts.startRename

  useEffect(() => {
    let clicked: TreeNode | null = null

    const onPointerDown = (event: PointerEvent): void => {
      const container = opts.containerRef.current
      const target = event.target instanceof Element ? event.target : null
      const index =
        container && target && container.contains(target)
          ? target.closest<HTMLElement>('[data-index]')?.dataset.index
          : undefined
      clicked = index === undefined ? null : rowProjectionRef.current.getRowAtIndex(Number(index))
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const node = clicked
      // Only the key right after the click counts; anything else means the user moved on.
      clicked = null
      const container = opts.containerRef.current
      if (
        !node ||
        node.outsideProject ||
        // Focus still in the tree: the explorer's key handler owns the chord.
        (container && document.activeElement && container.contains(document.activeElement)) ||
        // Why: Enter typed into the freshly opened editor is text, not a rename request.
        event.key === 'Enter' ||
        !keybindingMatchesAction('fileExplorer.rename', event, getShortcutPlatform(), keybindings)
      ) {
        return
      }
      event.preventDefault()
      // Keep the editor (Monaco binds F2 to symbol rename) from also acting on it.
      event.stopPropagation()
      startRenameRef.current(node)
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    addAppKeyListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      removeAppKeyListener('keydown', onKeyDown)
    }
  }, [keybindings, opts.containerRef])
}
