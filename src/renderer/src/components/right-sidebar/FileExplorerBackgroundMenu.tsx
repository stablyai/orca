import React, { useEffect, useState } from 'react'
import { ClipboardPaste, FilePlus, FolderPlus } from 'lucide-react'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/components/tab-bar/SortableTab'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  getCachedPastableClipboardFilePaths,
  getPastableClipboardFilePaths
} from './file-explorer-clipboard-paste'

function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: the synthetic trigger sits at the cursor; the right-button release
  // can otherwise land on "New File" and select it immediately.
  event.preventDefault()
  event.stopPropagation()
}

export function FileExplorerBackgroundMenu({
  open,
  onOpenChange,
  point,
  worktreePath,
  onStartNew,
  onPasteFiles
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  worktreePath: string
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  onPasteFiles: (sourcePaths: string[], destinationDir: string) => void
}): React.JSX.Element {
  const [pastablePaths, setPastablePaths] = useState<string[]>([])
  useEffect(() => {
    const close = (): void => onOpenChange(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
  }, [onOpenChange])

  // Why: render instantly from the warm cache (a fresh Windows probe takes
  // hundreds of ms), then reconcile when the on-open probe lands. Paste only
  // appears when the OS clipboard actually holds file references.
  useEffect(() => {
    if (!open) {
      setPastablePaths([])
      return
    }
    setPastablePaths(getCachedPastableClipboardFilePaths())
    let cancelled = false
    void getPastableClipboardFilePaths().then((paths) => {
      if (!cancelled) {
        setPastablePaths(paths)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: point.x, top: point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-48"
        sideOffset={0}
        align="start"
        onPointerUpCapture={stopRightButtonMenuSelection}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => onStartNew('file', worktreePath, 0)}>
          <FilePlus />
          {translate(
            'auto.components.right.sidebar.FileExplorerBackgroundMenu.21fe46ed36',
            'New File'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onStartNew('folder', worktreePath, 0)}>
          <FolderPlus />
          {translate(
            'auto.components.right.sidebar.FileExplorerBackgroundMenu.3b5e2dcb8d',
            'New Folder'
          )}
        </DropdownMenuItem>
        {pastablePaths.length > 0 ? (
          <DropdownMenuItem onSelect={() => onPasteFiles(pastablePaths, worktreePath)}>
            <ClipboardPaste />
            {pastablePaths.length > 1
              ? translate(
                  'auto.components.right.sidebar.FileExplorerBackgroundMenu.pasteFiles',
                  'Paste {{value0}} Files',
                  { value0: pastablePaths.length }
                )
              : translate(
                  'auto.components.right.sidebar.FileExplorerBackgroundMenu.paste',
                  'Paste'
                )}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
