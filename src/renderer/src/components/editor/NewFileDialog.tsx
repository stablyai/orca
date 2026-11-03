import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getNamedFileRelativeDirectory, hasPathSeparator } from '@/lib/create-named-file'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type NewFileDialogProps = {
  worktreePath: string
  defaultFolder: string
  disableBrowse?: boolean
  /** Name a blank Name field would receive in `folder`; null when it cannot be determined. */
  suggestName: (folder: string) => Promise<string | null>
  /** Resolves to an error message to keep the dialog open, or null once the file is created. */
  onCreate: (request: { name: string; folder: string }) => Promise<string | null>
  onClose: () => void
}

export function NewFileDialog({
  worktreePath,
  defaultFolder,
  disableBrowse = false,
  suggestName,
  onCreate,
  onClose
}: NewFileDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState(defaultFolder)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [suggestion, setSuggestion] = useState<{ folder: string; name: string } | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameInputId = useId()
  const folderInputId = useId()
  const errorId = useId()
  const mountedRef = useMountedRef()

  useEffect(() => {
    let cancelled = false
    // Why: debounced so typing a path does not probe the filesystem per keystroke.
    const suggestedFolder = folder.trim()
    const timer = setTimeout(() => {
      void suggestName(suggestedFolder).then((next) => {
        if (!cancelled && next) {
          setSuggestion({ folder: suggestedFolder, name: next })
        }
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [folder, suggestName])

  // Why: a suggestion belongs to the folder it was looked up for; show none for another folder.
  const suggestedName = suggestion?.folder === folder.trim() ? suggestion.name : ''

  const handleBrowse = useCallback(async () => {
    const picked = await window.api.shell.pickDirectory({ defaultPath: folder || worktreePath })
    if (!picked || !mountedRef.current) {
      return
    }
    setFolder(picked)
    setError(null)
  }, [folder, mountedRef, worktreePath])

  const handleSubmit = useCallback(async () => {
    if (submitting) {
      return
    }
    const trimmedName = name.trim()
    if (hasPathSeparator(trimmedName)) {
      setError(
        translate(
          'auto.components.editor.NewFileDialog.nameHasSeparators',
          'Name cannot contain path separators'
        )
      )
      return
    }
    const trimmedFolder = folder.trim()
    if (!trimmedFolder) {
      setError(
        translate('auto.components.editor.NewFileDialog.folderEmpty', 'Folder path cannot be empty')
      )
      return
    }
    if (getNamedFileRelativeDirectory(trimmedFolder, worktreePath) === null) {
      setError(
        translate(
          'auto.components.editor.NewFileDialog.folderOutsideWorkspace',
          'Folder must be inside the current workspace'
        )
      )
      return
    }
    setSubmitting(true)
    const failure = await onCreate({ name: trimmedName, folder: trimmedFolder })
    if (!mountedRef.current) {
      return
    }
    setSubmitting(false)
    setError(failure)
  }, [folder, mountedRef, name, onCreate, submitting, worktreePath])

  const submitOnEnter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[340px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          nameInputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.editor.NewFileDialog.title', 'New file')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.editor.NewFileDialog.description',
              'Name your file and pick a folder. Leave the name empty to use the suggested name.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor={nameInputId}
              className="text-2xs font-medium text-muted-foreground mb-1 block"
            >
              {translate('auto.components.editor.NewFileDialog.name', 'Name')}
            </label>
            <Input
              id={nameInputId}
              ref={nameInputRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={submitOnEnter}
              placeholder={suggestedName}
              className="h-8"
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          <div>
            <label
              htmlFor={folderInputId}
              className="text-2xs font-medium text-muted-foreground mb-1 block"
            >
              {translate('auto.components.editor.NewFileDialog.folder', 'Folder')}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id={folderInputId}
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value)
                  setError(null)
                }}
                onKeyDown={submitOnEnter}
                className="h-8"
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={disableBrowse}
                onClick={() => void handleBrowse()}
                title={
                  disableBrowse
                    ? translate(
                        'auto.components.editor.NewFileDialog.browseUnavailable',
                        'Folder picker unavailable for remote files'
                      )
                    : translate('auto.components.editor.NewFileDialog.browse', 'Browse folders')
                }
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        {error && (
          <p id={errorId} className="text-xs text-destructive mt-1">
            {error}
          </p>
        )}
        <DialogFooter className="mt-1">
          <Button variant="outline" size="sm" onClick={onClose}>
            {translate('auto.components.editor.NewFileDialog.cancel', 'Cancel')}
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => void handleSubmit()}>
            {translate('auto.components.editor.NewFileDialog.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
