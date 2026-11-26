import React, { useId } from 'react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  measureTextControlPasteByteLength,
  pasteTextIntoTextControl,
  shouldHandleTextControlPaste
} from '@/lib/text-input/paste/text-control-paste'
import { TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES } from '@/lib/text-input/paste/text-control-paste-model'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export function NewWorkspaceComposerNoteField({
  note,
  onNoteChange,
  pipeline = false
}: {
  note: string
  onNoteChange: (note: string) => void
  pipeline?: boolean
}) {
  const t = useTranslate()
  const id = useId()
  const handleNotePaste = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain')
    const byteLengthMeasurement = measureTextControlPasteByteLength(text, {
      stopAfterBytes: TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
    })
    if (
      !byteLengthMeasurement.exceededLimit &&
      !shouldHandleTextControlPaste(text, { measuredByteLength: byteLengthMeasurement.byteLength })
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const textarea = event.currentTarget
    void pasteTextIntoTextControl(textarea, text, {
      source: 'clipboard',
      canContinue: (target) => target.ownerDocument.activeElement === target
    })
      .then((result) => {
        if (result.status === 'rejected' && result.reason === 'too-large') {
          toast.error(
            translate(
              'auto.components.NewWorkspaceComposerCard.notePasteTooLarge',
              'Paste is too large for the note field.'
            )
          )
        }
      })
      .catch(() => {})
  }, [])
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {pipeline
          ? t('pipelines.task', 'Task')
          : t('auto.components.NewWorkspaceComposerCard.f8728aa4f9', 'Note')}
      </Label>
      <Textarea
        id={id}
        value={note}
        placeholder={
          pipeline
            ? undefined
            : t('auto.components.NewWorkspaceComposerCard.090cfedeb4', 'Write a note')
        }
        onChange={(event) => onNoteChange(event.target.value)}
        onPaste={handleNotePaste}
        rows={pipeline ? 3 : 1}
        aria-invalid={pipeline && JSON.stringify(note).length > 12000}
        className="max-h-60 resize-y"
      />
      {pipeline && (
        <p className="text-xs text-muted-foreground">
          {t(
            'pipelines.taskLimit',
            'The complete task, including linked issue details, must fit within 12,000 characters. Input is preserved on errors.'
          )}
        </p>
      )}
    </div>
  )
}
