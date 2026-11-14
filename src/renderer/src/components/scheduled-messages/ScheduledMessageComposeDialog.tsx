import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'
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
import { translate } from '@/i18n/i18n'
import type {
  ScheduledMessage,
  ScheduledMessageTiming
} from '../../../../shared/scheduled-message-types'
import {
  validateScheduledMessageDraft,
  type ScheduledMessageValidationError
} from '../../../../shared/scheduled-message-validation'
import { fromLocalDateTimeInputs, toLocalDateTimeInputs } from './scheduled-message-format'

type ScheduledMessageComposeDialogProps = {
  open: boolean
  /** Present when editing; absent when composing a new message. */
  message?: ScheduledMessage
  onOpenChange: (open: boolean) => void
  onSubmit: (draft: { text: string; timing: ScheduledMessageTiming }) => Promise<void> | void
}

/** An hour out, on the minute boundary — the near-future default Telegram uses. */
function defaultSendAt(): number {
  const value = new Date(Date.now() + 60 * 60 * 1000)
  value.setSeconds(0, 0)
  return value.getTime()
}

/** A past time would open on the past-time error. */
function initialSendAt(timing: ScheduledMessageTiming): number {
  return timing.kind === 'at' && timing.sendAt > Date.now() ? timing.sendAt : defaultSendAt()
}

function validationMessage(error: ScheduledMessageValidationError | null): string | null {
  if (error === 'empty-text') {
    return translate('auto.components.scheduledMessages.errorEmpty', 'Enter a message to send.')
  }
  if (error === 'send-at-in-past') {
    return translate('auto.components.scheduledMessages.errorPast', 'Pick a time in the future.')
  }
  if (error === 'send-at-beyond-horizon') {
    return translate(
      'auto.components.scheduledMessages.errorHorizon',
      'Messages can be scheduled up to a year ahead.'
    )
  }
  return null
}

function formErrorMessage(
  text: string,
  timing: ScheduledMessageTiming | null,
  error: ScheduledMessageValidationError | null
): string | null {
  if (timing === null) {
    return translate(
      'auto.components.scheduledMessages.errorInvalidDateTime',
      'Pick a valid date and time.'
    )
  }
  // An untouched empty field should not shout at the user before they type.
  if (text.length === 0 && error === 'empty-text') {
    return null
  }
  return validationMessage(error)
}

/** The IPC layer wraps main's bare code in its own prose, so match inside the
 *  message rather than comparing it. */
function submitFailureMessage(failure: unknown): string {
  const raw = failure instanceof Error ? failure.message : String(failure)
  if (raw.includes('too-many-scheduled-messages')) {
    return translate(
      'auto.components.scheduledMessages.errorTooMany',
      'This workspace already has as many scheduled messages as Orca allows. Send or delete one first.'
    )
  }
  const known = (['empty-text', 'send-at-in-past', 'send-at-beyond-horizon'] as const).find(
    (code) => raw.includes(code)
  )
  return (
    (known ? validationMessage(known) : null) ??
    translate(
      'auto.components.scheduledMessages.errorSaveFailed',
      "Orca couldn't save this scheduled message."
    )
  )
}

/** Compose or edit one scheduled message; shared by the workspace context menu
 *  and the Automations page. */
export function ScheduledMessageComposeDialog({
  open,
  message,
  onOpenChange,
  onSubmit
}: ScheduledMessageComposeDialogProps): React.JSX.Element {
  const textId = useId()
  const [text, setText] = useState('')
  const [kind, setKind] = useState<ScheduledMessageTiming['kind']>('at')
  const [dateValue, setDateValue] = useState('')
  const [timeValue, setTimeValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitFailure, setSubmitFailure] = useState<string | null>(null)
  // Captured, not Date.now() per render: a moving clock flips the error text under
  // the user mid-typing. Re-seeded on every open, since the dialog stays mounted.
  const [openedAt, setOpenedAt] = useState(() => Date.now())
  const [seed, setSeed] = useState<{ open: boolean; messageId: string | null }>({
    open: false,
    messageId: null
  })

  // Why derived-during-render rather than an Effect: an Effect renders one frame
  // with the previous message's draft still in the fields.
  const messageId = message?.id ?? null
  if (open !== seed.open || messageId !== seed.messageId) {
    setSeed({ open, messageId })
    if (open) {
      const timing = message?.timing ?? { kind: 'at' as const, sendAt: defaultSendAt() }
      const inputs = toLocalDateTimeInputs(initialSendAt(timing))
      setText(message?.text ?? '')
      setKind(timing.kind)
      setDateValue(inputs.date)
      setTimeValue(inputs.time)
      setSubmitting(false)
      setSubmitFailure(null)
    }
  }

  // An Effect, not the seeding block above: reading the clock during render is
  // impure, and the submit path re-reads Date.now() anyway.
  useEffect(() => {
    if (open) {
      setOpenedAt(Date.now())
    }
  }, [open])

  // Memoized because handleSubmit closes over it: a fresh object each render
  // would defeat the useCallback and re-create the form's submit handler.
  const timing = useMemo<ScheduledMessageTiming | null>(() => {
    if (kind === 'when-idle') {
      return { kind: 'when-idle' }
    }
    const sendAt = fromLocalDateTimeInputs(dateValue, timeValue)
    return sendAt === null ? null : { kind: 'at', sendAt }
  }, [dateValue, kind, timeValue])
  const error = timing === null ? null : validateScheduledMessageDraft({ text, timing }, openedAt)
  const shownError = submitFailure ?? formErrorMessage(text, timing, error)

  const handleSubmit = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (timing === null || error !== null || submitting) {
        return
      }
      setSubmitFailure(null)
      // A dialog left sitting past the time it holds would submit a moment already
      // gone and be rejected after the round trip.
      const lateError = validateScheduledMessageDraft({ text, timing }, Date.now())
      if (lateError) {
        setSubmitFailure(validationMessage(lateError))
        return
      }
      setSubmitting(true)
      try {
        await onSubmit({ text, timing })
        onOpenChange(false)
      } catch (failure) {
        // Keep the dialog open: the text is the user's, and closing on a
        // rejection would throw it away with nothing said.
        setSubmitFailure(submitFailureMessage(failure))
      } finally {
        setSubmitting(false)
      }
    },
    [error, onOpenChange, onSubmit, submitting, text, timing]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {message
                ? translate('auto.components.scheduledMessages.editTitle', 'Edit scheduled message')
                : translate('auto.components.scheduledMessages.composeTitle', 'Schedule a message')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.scheduledMessages.composeDescription',
                "Orca types this into the workspace's agent when it comes due."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={textId}>
                {translate('auto.components.scheduledMessages.messageLabel', 'Message')}
              </Label>
              <Textarea
                id={textId}
                value={text}
                rows={4}
                autoFocus
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{translate('auto.components.scheduledMessages.whenLabel', 'When')}</Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={kind === 'at'}
                  onChange={() => setKind('at')}
                  name="scheduled-message-timing"
                />
                {translate('auto.components.scheduledMessages.atDateTime', 'At a date and time')}
              </label>
              {kind === 'at' ? (
                <div className="flex flex-col gap-1.5 pl-6">
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={dateValue}
                      onChange={(event) => setDateValue(event.target.value)}
                    />
                    <Input
                      type="time"
                      value={timeValue}
                      onChange={(event) => setTimeValue(event.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-pretty">
                    {translate(
                      'auto.components.scheduledMessages.atTimeHint',
                      'Sends at that time even if the agent is mid-task, interrupting it.'
                    )}
                  </p>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={kind === 'when-idle'}
                  onChange={() => setKind('when-idle')}
                  name="scheduled-message-timing"
                />
                {translate(
                  'auto.components.scheduledMessages.whenIdleOption',
                  'When the agent is idle'
                )}
              </label>
              {kind === 'when-idle' ? (
                <p className="pl-6 text-xs text-muted-foreground text-pretty">
                  {translate(
                    'auto.components.scheduledMessages.whenIdleHint',
                    'Delivers the next time this workspace’s agent finishes working.'
                  )}
                </p>
              ) : null}
            </div>
            {shownError ? <p className="text-xs text-destructive">{shownError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {translate('auto.components.scheduledMessages.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={timing === null || error !== null || submitting}>
              {message
                ? translate('auto.components.scheduledMessages.save', 'Save')
                : translate('auto.components.scheduledMessages.schedule', 'Schedule')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
