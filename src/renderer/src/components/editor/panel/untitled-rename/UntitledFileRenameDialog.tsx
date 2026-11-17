import React, { useCallback, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getRelativePathInsideRoot } from '@/lib/path'
import { resolveRuntimePath } from '../../../../../../shared/file-access/cross-platform-path'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { splitUntitledFileName } from './untitled-file-rename-path'

type UntitledFileRenameDialogProps = {
  open: boolean
  currentName: string
  worktreePath: string
  externalError?: string | null
  disableBrowse?: boolean
  title?: string
  description?: string
  confirmLabel?: string
  preserveExtension?: boolean
  initialDirectory?: string
  pending?: boolean
  showPendingIndicator?: boolean
  onInputChange?: () => void
  onClose: () => void
  onConfirm: (newRelativePath: string) => void
}

export function UntitledFileRenameDialog({
  open,
  currentName,
  worktreePath,
  externalError,
  disableBrowse = false,
  title,
  description,
  confirmLabel,
  preserveExtension = true,
  initialDirectory = worktreePath,
  pending = false,
  showPendingIndicator = false,
  onInputChange,
  onClose,
  onConfirm
}: UntitledFileRenameDialogProps): React.JSX.Element {
  const t = useTranslate()
  const fieldId = useId()
  const [name, setName] = useState('')
  const [dir, setDir] = useState(worktreePath)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number | null>(null)
  const [seededOpenState, setSeededOpenState] = useState({ open: false, currentName, worktreePath })
  const mountedRef = useMountedRef()

  const displayError = externalError ?? error

  const cancelFocusFrame = useCallback(() => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setNameInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      if (!node) {
        // Radix may unmount before deferred focus runs; cancel from ref cleanup.
        cancelFocusFrame()
      }
      nameInputRef.current = node
    },
    [cancelFocusFrame]
  )

  // Seed before painting; Radix’s open lifecycle owns focus without a post-render effect.
  if (open) {
    if (
      !seededOpenState.open ||
      seededOpenState.currentName !== currentName ||
      seededOpenState.worktreePath !== worktreePath
    ) {
      setSeededOpenState({ open: true, currentName, worktreePath })
      setName(preserveExtension ? splitUntitledFileName(currentName).stem : currentName)
      setDir(initialDirectory)
      setError(null)
    }
  } else if (seededOpenState.open) {
    // Why: the parent clears currentName on close; keep the saved suffix through the fade-out.
    setSeededOpenState({ ...seededOpenState, open: false })
  }
  const extension = preserveExtension
    ? splitUntitledFileName(seededOpenState.currentName).extension
    : ''

  const handleBrowse = useCallback(async () => {
    const picked = await window.api.shell.pickDirectory({ defaultPath: dir || worktreePath })
    if (!picked) {
      return
    }
    if (!mountedRef.current) {
      return
    }
    setDir(picked)
    setError(null)
    onInputChange?.()
  }, [dir, mountedRef, onInputChange, worktreePath])

  const handleSubmit = useCallback(() => {
    if (pending) {
      return
    }
    const typedName = name.trim()
    const stem =
      extension && typedName.endsWith(extension) ? typedName.slice(0, -extension.length) : typedName
    if (!stem) {
      setError(
        translate(
          'auto.components.editor.UntitledFileRenameDialog.nameEmpty',
          'Name cannot be empty'
        )
      )
      return
    }
    if (/[/\\]/.test(stem)) {
      setError(
        translate(
          'auto.components.editor.UntitledFileRenameDialog.nameHasSeparators',
          'Name cannot contain path separators'
        )
      )
      return
    }

    const trimmedDir = preserveExtension ? dir.trim().replace(/[\\/]+$/, '') : dir.trim()
    if (!trimmedDir) {
      setError(
        translate(
          'auto.components.editor.UntitledFileRenameDialog.folderEmpty',
          'Folder path cannot be empty'
        )
      )
      return
    }

    const relDir = getRelativePathInsideRoot(
      preserveExtension ? trimmedDir : resolveRuntimePath(worktreePath, trimmedDir),
      worktreePath
    )
    if (relDir === null) {
      setError(
        translate(
          'auto.components.editor.UntitledFileRenameDialog.folderOutsideWorkspace',
          'Folder must be inside the current workspace'
        )
      )
      return
    }

    const fileName = `${stem}${extension}`
    if (!preserveExtension && (fileName === '.' || fileName === '..')) {
      setError(
        translate(
          'auto.components.editor.UntitledFileRenameDialog.invalidName',
          'Enter a file name'
        )
      )
      return
    }
    const relativePath = relDir ? `${relDir}/${fileName}` : fileName
    onConfirm(relativePath)
  }, [name, dir, extension, worktreePath, onConfirm, pending, preserveExtension])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !pending && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[340px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelFocusFrame()
          focusFrameRef.current = requestAnimationFrame(() => {
            focusFrameRef.current = null
            nameInputRef.current?.focus()
            nameInputRef.current?.select()
          })
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {title ?? t('auto.components.editor.UntitledFileRenameDialog.674b046582', 'Save as')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {description ??
              t(
                'auto.components.editor.UntitledFileRenameDialog.description',
                'Name your file and pick a folder.'
              )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor={`${fieldId}-name`}
              className="text-2xs font-medium text-muted-foreground mb-1 block"
            >
              {t('auto.components.editor.UntitledFileRenameDialog.b6ed807cc6', 'Name')}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id={`${fieldId}-name`}
                ref={setNameInputNode}
                value={name}
                disabled={pending}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                  onInputChange?.()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                placeholder={t(
                  'auto.components.editor.UntitledFileRenameDialog.c8ac7868e6',
                  'file name'
                )}
                className="h-8 text-sm"
                aria-invalid={!!displayError}
              />
              {extension && (
                <span className="text-xs text-muted-foreground shrink-0">{extension}</span>
              )}
            </div>
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-folder`}
              className="text-2xs font-medium text-muted-foreground mb-1 block"
            >
              {t('auto.components.editor.UntitledFileRenameDialog.30099dca46', 'Folder')}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id={`${fieldId}-folder`}
                value={dir}
                disabled={pending}
                onChange={(e) => {
                  setDir(e.target.value)
                  setError(null)
                  onInputChange?.()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                className="h-8 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={disableBrowse || pending}
                onClick={() => void handleBrowse()}
                title={
                  disableBrowse
                    ? t(
                        'auto.components.editor.UntitledFileRenameDialog.5e7f0d8a80',
                        'Folder picker unavailable for remote files'
                      )
                    : t(
                        'auto.components.editor.UntitledFileRenameDialog.725868c75d',
                        'Browse folders'
                      )
                }
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        {displayError && (
          <p role="alert" className="text-xs text-destructive mt-1">
            {displayError}
          </p>
        )}
        <DialogFooter className="mt-1">
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            {t('auto.components.editor.UntitledFileRenameDialog.949711deb4', 'Cancel')}
          </Button>
          <Button size="sm" disabled={pending} aria-busy={pending} onClick={handleSubmit}>
            <span className="relative">
              <span className={showPendingIndicator ? 'invisible' : undefined}>
                {confirmLabel ??
                  t('auto.components.editor.UntitledFileRenameDialog.a7dd27b0bc', 'Save')}
              </span>
              {showPendingIndicator && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <LoadingSpinner className="size-4" />
                </span>
              )}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
