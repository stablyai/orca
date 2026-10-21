import React from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkInboxItem, WorkInboxStatus } from '../../../../shared/work-inbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import {
  canSubmitWorkInboxDraft,
  isWorkInboxDraftLocked,
  type WorkInboxDraft
} from './work-inbox-answer-draft'

function statusLabel(status: WorkInboxStatus): string {
  switch (status) {
    case 'open':
      return translate('auto.components.work-inbox.status.open', 'Unanswered')
    case 'answered':
    case 'delivered':
      return translate('auto.components.work-inbox.status.answered', 'Answered')
    case 'cancelled':
      return translate('auto.components.work-inbox.status.cancelled', 'Closed without an answer')
  }
}

function draftFailureMessage(failure: NonNullable<WorkInboxDraft['failure']>): string {
  switch (failure) {
    case 'conflict':
      return translate(
        'auto.components.work-inbox.error.conflict',
        'This question changed before your answer was saved. Your draft is kept; review the current state above.'
      )
    case 'not-found':
      return translate(
        'auto.components.work-inbox.error.notFound',
        'This question no longer exists on this host. Your draft is kept.'
      )
    case 'unreachable':
      return translate(
        'auto.components.work-inbox.error.unreachable',
        'Could not confirm the answer was saved. Editing is locked until the host confirms it; Retry sends the same answer, so it is not duplicated.'
      )
  }
}

function sendShortcutMatches(event: React.KeyboardEvent): boolean {
  const isMac = navigator.userAgent.includes('Mac')
  return event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
}

export function WorkInboxItemCard({
  item,
  draft,
  now,
  onDraftChange,
  onSubmit,
  onStatusChange,
  statusBusy,
  statusFailed
}: {
  item: WorkInboxItem
  draft: WorkInboxDraft
  now: number
  onDraftChange: (patch: Partial<Pick<WorkInboxDraft, 'optionId' | 'text'>>) => void
  onSubmit: () => void
  onStatusChange: () => void
  statusBusy?: boolean
  statusFailed?: boolean
}): React.JSX.Element {
  const textId = `work-inbox-answer-${item.id}`
  const errorId = `work-inbox-error-${item.id}`
  const isOpen = item.status === 'open'
  const canSubmit = canSubmitWorkInboxDraft(item, draft)
  const locked = isWorkInboxDraftLocked(draft) || statusBusy
  const closeLabel = translate(
    'auto.components.work-inbox.closeQuestion',
    'Close without answering'
  )
  const cannotAnswer = isOpen && item.options.length === 0 && !item.allowFreeText

  return (
    <article
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      aria-labelledby={`work-inbox-question-${item.id}`}
      data-status={item.status}
    >
      <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{item.agentLabel}</span>
        {item.projectLabel ? <span>{item.projectLabel}</span> : null}
        <span>{formatUiRelativeTime(item.createdAt - now)}</span>
        <div className="ml-auto flex flex-wrap gap-2" role="status">
          <Badge variant={isOpen ? 'default' : 'outline'}>{statusLabel(item.status)}</Badge>
          {item.status === 'answered' || item.status === 'delivered' ? (
            <Badge variant="outline">
              {item.status === 'delivered'
                ? translate('auto.components.work-inbox.status.delivered', 'Agent received')
                : translate(
                    'auto.components.work-inbox.status.awaitingReceipt',
                    'Waiting for agent'
                  )}
            </Badge>
          ) : null}
        </div>
        {isOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={closeLabel}
                disabled={locked}
                onClick={onStatusChange}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{closeLabel}</TooltipContent>
          </Tooltip>
        ) : item.status === 'cancelled' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={statusBusy}
            onClick={onStatusChange}
          >
            {translate('auto.components.work-inbox.reopen', 'Reopen question')}
          </Button>
        ) : null}
      </header>
      {statusFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'auto.components.work-inbox.statusFailed',
            'Could not confirm the change. Refresh to check its status before trying again.'
          )}
        </p>
      ) : null}
      <p
        id={`work-inbox-question-${item.id}`}
        className="text-sm whitespace-pre-wrap break-words text-foreground"
      >
        {item.question}
      </p>

      {item.answer ? (
        <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
          <div className="text-xs text-muted-foreground">
            {translate('auto.components.work-inbox.yourAnswer', 'Your answer')}
          </div>
          {item.answer.optionLabel ? <div>{item.answer.optionLabel}</div> : null}
          {item.answer.text ? (
            <div className="whitespace-pre-wrap break-words">{item.answer.text}</div>
          ) : null}
        </div>
      ) : null}

      {isOpen && item.options.length > 0 ? (
        <div
          role="group"
          aria-label={translate('auto.components.work-inbox.options', 'Answer options')}
          className="space-y-2"
        >
          {item.options.map((option) => {
            const selected = draft.optionId === option.id
            return (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 text-sm has-data-[state=checked]:bg-accent"
              >
                <Checkbox
                  checked={selected}
                  disabled={locked}
                  className="mt-0.5"
                  aria-label={option.label}
                  onCheckedChange={() => onDraftChange({ optionId: selected ? null : option.id })}
                />
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {option.label}
                  {option.description ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>
      ) : null}
      {isOpen && item.options.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.work-inbox.selectionHint',
            'Choose one option, then send your answer.'
          )}
        </p>
      ) : null}

      {isOpen && item.allowFreeText ? (
        <div className="space-y-1">
          <label htmlFor={textId} className="text-xs text-muted-foreground">
            {item.options.length > 0
              ? translate('auto.components.work-inbox.addNote', 'Add a note (optional)')
              : translate('auto.components.work-inbox.answerLabel', 'Answer')}
          </label>
          <Textarea
            id={textId}
            value={draft.text}
            disabled={locked}
            aria-describedby={draft.failure ? errorId : undefined}
            onChange={(event) => onDraftChange({ text: event.target.value })}
            onKeyDown={(event) => {
              if (sendShortcutMatches(event)) {
                event.preventDefault()
                onSubmit()
              }
            }}
          />
        </div>
      ) : null}

      {cannotAnswer ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.work-inbox.noAnswerShape',
            'This question has no options and does not accept text.'
          )}
        </p>
      ) : null}

      {draft.failure ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {draftFailureMessage(draft.failure)}
        </p>
      ) : null}

      {isOpen && !cannotAnswer ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            className="w-36"
            disabled={!canSubmit || statusBusy}
            aria-busy={draft.submitting}
            onClick={onSubmit}
          >
            {draft.submitting ? <LoadingSpinner className="size-4" /> : null}
            {draft.failure === 'unreachable'
              ? translate('auto.components.work-inbox.retry', 'Retry')
              : translate('auto.components.work-inbox.send', 'Send answer')}
          </Button>
        </div>
      ) : null}
    </article>
  )
}
