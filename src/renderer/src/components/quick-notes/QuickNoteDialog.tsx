import { useRef, useState } from 'react'
import type { QuickNote } from '../../../../shared/quick-note-types'
import {
  MAX_QUICK_NOTE_BODY_LENGTH,
  MAX_QUICK_NOTE_LABEL_LENGTH
} from '../../../../shared/quick-notes'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'

type QuickNoteDialogMode = 'add' | 'edit'

type QuickNoteDialogProps = {
  open: boolean
  mode: QuickNoteDialogMode
  note: QuickNote
  onOpenChange: (open: boolean) => void
  onSave: (note: QuickNote) => void
}

export function createQuickNoteDraft(): QuickNote {
  return { id: `quick-note-${createBrowserUuid()}`, label: '', body: '' }
}

export function QuickNoteDialog({
  open,
  mode,
  note,
  onOpenChange,
  onSave
}: QuickNoteDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<QuickNote>(note)
  const syncedNoteRef = useRef<QuickNote | null>(null)

  // Why: re-seed the local draft whenever the dialog (re)opens for a new note.
  if (open && syncedNoteRef.current !== note) {
    syncedNoteRef.current = note
    setDraft({ ...note })
  } else if (!open && syncedNoteRef.current !== null) {
    syncedNoteRef.current = null
  }

  const canSave = draft.label.trim().length > 0 && draft.body.trim().length > 0

  const save = (): void => {
    if (!canSave) {
      return
    }
    onSave({ id: draft.id, label: draft.label.trim(), body: draft.body.trimEnd() })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg gap-4"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event) && canSave) {
            event.preventDefault()
            save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'edit'
              ? translate(
                  'auto.components.quick.notes.QuickNoteDialog.editTitle',
                  'Edit Quick Note'
                )
              : translate('auto.components.quick.notes.QuickNoteDialog.addTitle', 'Add Quick Note')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.quick.notes.QuickNoteDialog.description',
              'Saved notes appear in the tab bar menu; picking one copies it to the clipboard.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="quick-note-label">
            {translate('auto.components.quick.notes.QuickNoteDialog.labelField', 'Label')}
          </Label>
          <Input
            id="quick-note-label"
            autoFocus
            value={draft.label}
            maxLength={MAX_QUICK_NOTE_LABEL_LENGTH}
            placeholder={translate(
              'auto.components.quick.notes.QuickNoteDialog.labelPlaceholder',
              'Email signature'
            )}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="quick-note-body">
            {translate('auto.components.quick.notes.QuickNoteDialog.bodyField', 'Text')}
          </Label>
          <Textarea
            id="quick-note-body"
            className="min-h-[180px] font-mono text-xs"
            value={draft.body}
            maxLength={MAX_QUICK_NOTE_BODY_LENGTH}
            placeholder={translate(
              'auto.components.quick.notes.QuickNoteDialog.bodyPlaceholder',
              'The text copied to your clipboard when you pick this note.'
            )}
            onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('auto.components.quick.notes.QuickNoteDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!canSave} onClick={save}>
            {translate('auto.components.quick.notes.QuickNoteDialog.save', 'Save')}
            <span className="ml-1.5 text-[11px] opacity-60">{getScreenSubmitShortcutLabel()}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
