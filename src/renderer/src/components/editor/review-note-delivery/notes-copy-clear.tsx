import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/index'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { describeClipboardWriteFailure } from '@/lib/clipboard/clipboard-write-failure'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { isWindowsAbsolutePathLike } from '../../../../../shared/file-access/cross-platform-path'
import {
  dismissClearNotesFailedToast,
  showClearNotesFailedToast
} from '@/store/slices/diff-comments/clear-notes-failed-toast'

/** Copy and Clear at the bottom of a send menu. */
export function NotesMenuCopyClearItems({
  onCopy,
  onClear
}: {
  onCopy: () => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCopy}>
        <Copy className="size-3.5" />
        {t('components.notes.sendButton.copyNotes', 'Copy notes')}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={onClear}>
        <Trash2 className="size-3.5" />
        {t('components.notes.sendButton.clearNotes', 'Clear notes…')}
      </DropdownMenuItem>
    </>
  )
}

export async function copyNotesText(text: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
  } catch (error) {
    toast.error(
      translate(
        'auto.components.right.sidebar.SourceControl.diffCommentNotesCopyFailed',
        'Failed to copy notes'
      ),
      { description: describeClipboardWriteFailure(error) }
    )
  }
}

// Why not a cross-platform basename: a backslash is a legal POSIX name character, so it splits only Windows paths.
function fileNameOf(filePath: string): string {
  const separators = isWindowsAbsolutePathLike(filePath) ? /[\\/]/ : /\//
  return filePath.split(separators).findLast(Boolean) ?? filePath
}

/** One short line: callers pass relative or absolute paths, so show only the file name. */
export function clearNotesDescription(count: number, filePath?: string): string {
  return filePath
    ? translate(
        'auto.components.right.sidebar.SourceControl.clearNotesFromFile',
        'Clear {{count}} notes from {{path}}?',
        {
          count,
          path: fileNameOf(filePath),
          defaultValue_one: 'Clear {{count}} note from {{path}}?'
        }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.clearNotesFromWorkspace',
        'Clear {{count}} notes from this workspace?',
        { count, defaultValue_one: 'Clear {{count}} note from this workspace?' }
      )
}

export function ClearNotesDialog({
  open,
  description,
  isClearing,
  onConfirm,
  onDismiss
}: {
  open: boolean
  description: string
  isClearing: boolean
  onConfirm: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isClearing) {
          onDismiss()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.editor.CombinedDiffViewer.948a5fd6c8', 'Clear Notes')}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss} disabled={isClearing}>
            {t('auto.components.editor.CombinedDiffViewer.0f806a2ab1', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isClearing}>
            <Trash2 className="size-4" />
            {t('auto.components.editor.CombinedDiffViewer.948a5fd6c8', 'Clear Notes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type NotesClearRequest = { description: string; clear: () => Promise<boolean> }

async function runClear(pending: NotesClearRequest): Promise<boolean> {
  try {
    return await pending.clear()
  } catch (error) {
    console.error('Failed to clear notes:', error)
    return false
  }
}

/**
 * Asks before clearing. The request carries the exact notes to clear, captured when the
 * user picked Clear, so notes added while the dialog is open stay.
 */
export function useClearNotesConfirm(): {
  requestClear: (pending: NotesClearRequest) => void
  dialog: React.JSX.Element | null
} {
  const [pending, setPending] = useState<NotesClearRequest | null>(null)
  const [isClearing, setIsClearing] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const confirm = useCallback(async (): Promise<void> => {
    if (!pending || isClearing) {
      return
    }
    setIsClearing(true)
    const ok = await runClear(pending)
    if (!mountedRef.current) {
      return
    }
    setIsClearing(false)
    if (ok) {
      dismissClearNotesFailedToast()
      setPending(null)
    } else {
      showClearNotesFailedToast()
    }
  }, [isClearing, pending])

  return {
    requestClear: setPending,
    dialog: pending ? (
      <ClearNotesDialog
        open={pending !== null}
        description={pending?.description ?? ''}
        isClearing={isClearing}
        onConfirm={() => void confirm()}
        onDismiss={() => setPending(null)}
      />
    ) : null
  }
}

/** A Clear request for review notes: the owner and ids are fixed when it is made. */
export function diffNotesClearRequest(
  owner: DiffCommentOwner,
  notes: readonly { id: string }[],
  filePath?: string
): NotesClearRequest {
  const ids = notes.map((note) => note.id)
  return {
    description: clearNotesDescription(ids.length, filePath),
    clear: () => useAppStore.getState().deleteDiffCommentsByIds(owner, ids)
  }
}
