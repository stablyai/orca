import React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

/** Prefilled agent prompt (e.g. from a plugin task's start recipe), editable before Create. */
export function NewWorkspaceComposerAgentDraftSection({
  value,
  onChange,
  unavailableReason,
  sessionNote
}: {
  value: string
  onChange: (value: string) => void
  unavailableReason: string | null
  /** Which model/effort the launch uses, when the opener pinned them. */
  sessionNote?: string | null
}): React.JSX.Element {
  const inputId = React.useId()
  const helpId = React.useId()
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
