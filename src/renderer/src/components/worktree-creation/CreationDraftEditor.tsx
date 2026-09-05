import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { submitCreationDraft } from '@/lib/workspace-creation-drafts/creation-draft-submit'
import {
  useCreationDraftSession,
  editCreationDraft,
  discardCreationDraft,
  flushCreationDraft,
  saveCreationDraftCopy
} from '@/lib/workspace-creation-drafts/creation-draft-session'
import {
  CREATION_DRAFT_LIMIT,
  CREATION_DRAFT_TEXT_BYTES,
  type CreationDraftInput
} from '@/lib/workspace-creation-drafts/creation-draft-record'

export function CreationDraftEditor({
  initial,
  editorRef
}: {
  initial: CreationDraftInput
  editorRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const entry = useCreationDraftSession((state) => state.entries[initial.id])
  const buffer = entry?.buffer ?? initial
  const [actionPending, setActionPending] = useState(false)
  const [sendError, setSendError] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const atCapacity = useCreationDraftSession(
    (state) =>
      !state.entries[initial.id] && Object.keys(state.entries).length >= CREATION_DRAFT_LIMIT
  )
  const send = async (): Promise<void> => {
    setActionPending(true)
    setSendError(false)
    try {
      const result = await submitCreationDraft(buffer.id)
      setSendError(result.status !== 'delivered' && result.status !== 'uncertain')
    } catch {
      setSendError(true)
    } finally {
      setActionPending(false)
    }
  }
  const copy = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(buffer.text)
    } catch {
      toast.error(translate('creationDraft.copyFailed', 'Could not copy the draft.'))
    }
  }
  const saveCopy = async (): Promise<void> => {
    setActionPending(true)
    try {
      await saveCreationDraftCopy(buffer.id)
      toast.success(
        translate(
          'creationDraft.copySaved',
          'Saved separately. Use Copy draft to bring this text to your agent.'
        )
      )
    } catch {
      toast.error(
        translate(
          'creationDraft.copySaveFailed',
          'Could not save a separate draft. Your text is still here.'
        )
      )
    } finally {
      setActionPending(false)
    }
  }
  const discard = async (): Promise<void> => {
    setActionPending(true)
    try {
      await discardCreationDraft(buffer.id)
    } catch {
      toast.error(
        translate(
          'creationDraft.discardFailed',
          'Could not discard the draft. Your text is still here.'
        )
      )
    } finally {
      setActionPending(false)
    }
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Textarea
        ref={editorRef}
        autoFocus
        rows={4}
        className="max-h-64 resize-y font-mono text-sm"
        disabled={actionPending || atCapacity}
        aria-label={translate('creationDraft.promptLabel', 'Workspace prompt draft')}
        placeholder={translate(
          'creationDraft.promptPlaceholder',
          'Start your prompt while the workspace prepares…'
        )}
        value={buffer.text}
        onChange={(event) => {
          if (new TextEncoder().encode(event.target.value).byteLength > CREATION_DRAFT_TEXT_BYTES) {
            setInputError(
              translate(
                'creationDraft.tooLong',
                'That text exceeds the 64 KB draft limit. Your previous text is kept.'
              )
            )
            return
          }
          setInputError(null)
          editCreationDraft({
            ...buffer,
            text: event.target.value,
            delivery: buffer.delivery?.state === 'delivered' ? undefined : buffer.delivery,
            updatedAt: Date.now()
          })
        }}
      />
      {atCapacity || inputError ? (
        <p role="alert" className="text-xs text-destructive">
          {atCapacity
            ? translate(
                'creationDraft.full',
                'All 64 draft slots are in use. Discard a saved draft to start another.'
              )
            : inputError}
        </p>
      ) : null}
      {buffer.delivery ? (
        <p role="status" className="text-xs text-muted-foreground">
          {buffer.delivery.state === 'delivered'
            ? translate('creationDraft.delivered', 'Sent to the terminal. Your draft is kept here.')
            : translate(
                'creationDraft.uncertain',
                'Delivery is unconfirmed. Check the terminal before sending again. Your draft is kept here.'
              )}
        </p>
      ) : null}
      {sendError ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'creationDraft.sendFailed',
            'The original agent is not ready for this draft. Your text is still here; you can copy it or try again.'
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span
          role="status"
          className={`mr-auto text-xs ${entry?.error ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {entry?.conflict
            ? translate(
                'creationDraft.conflict',
                'This draft changed in another window. Save a separate copy to keep your text.'
              )
            : entry?.error
              ? translate(
                  'creationDraft.saveFailed',
                  'Not saved. Keep this window open or copy your text.'
                )
              : entry && entry.savedVersion !== entry.editVersion
                ? translate('creationDraft.saving', 'Saving…')
                : entry
                  ? translate('creationDraft.saved', 'Saved on this device')
                  : ''}
        </span>
        {entry?.conflict ? (
          <Button
            size="xs"
            variant="outline"
            disabled={actionPending}
            onClick={() => void saveCopy()}
          >
            {translate('creationDraft.saveCopy', 'Save a copy')}
          </Button>
        ) : entry?.error ? (
          <Button size="xs" variant="outline" onClick={() => void flushCreationDraft(buffer.id)}>
            {translate('creationDraft.retry', 'Retry')}
          </Button>
        ) : null}
        {buffer.target ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => activateAndRevealWorkspace(buffer.target!.worktreeId)}
          >
            {translate('creationDraft.openWorkspace', 'Open workspace')}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void discard()}
          disabled={!entry || actionPending}
        >
          {translate('creationDraft.discard', 'Discard')}
        </Button>
        {buffer.target?.terminalHandle && buffer.executionHostId === 'local' ? (
          <Button
            size="xs"
            disabled={!buffer.text.trim() || actionPending || Boolean(buffer.delivery)}
            onClick={() => void send()}
          >
            {actionPending
              ? translate('creationDraft.sending', 'Sending…')
              : translate('creationDraft.send', 'Send')}
          </Button>
        ) : null}
        <Button size="xs" variant="outline" disabled={!buffer.text} onClick={() => void copy()}>
          {translate('creationDraft.copy', 'Copy draft')}
        </Button>
      </div>
    </div>
  )
}
