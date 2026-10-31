import React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

/** Prefilled agent prompt (e.g. from a plugin task's start recipe), editable before Create;
 *  absent unless the opener prefilled one. */
export function NewWorkspaceComposerAgentDraftSection({
  agentDraft: value,
  onAgentDraftChange: onChange,
  agentDraftUnavailableReason,
  agentSessionNote: sessionNote
}: Pick<
  NewWorkspaceComposerCardProps,
  'agentDraft' | 'onAgentDraftChange' | 'agentDraftUnavailableReason' | 'agentSessionNote'
>): React.JSX.Element | null {
  const inputId = React.useId()
  const helpId = React.useId()
  if (value == null || !onChange) {
    return null
  }
  const unavailableReason = agentDraftUnavailableReason ?? null
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        {translate('auto.components.NewWorkspaceComposerCard.agentDraftLabel', 'Agent prompt')}
      </label>
      <Textarea
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={unavailableReason !== null}
        aria-describedby={helpId}
        rows={4}
        className="max-h-48 resize-none [field-sizing:content]"
      />
      <p id={helpId} className="text-[11px] text-muted-foreground">
        {unavailableReason ??
          translate(
            'auto.components.NewWorkspaceComposerCard.agentDraftHelp',
            'Typed into the agent as a draft. Review it there before sending.'
          )}
        {sessionNote && unavailableReason === null ? ` ${sessionNote}` : null}
      </p>
    </div>
  )
}
