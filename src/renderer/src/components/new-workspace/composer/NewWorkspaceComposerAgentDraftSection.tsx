import React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { describePluginTaskSessionOptions } from '@/lib/plugin-task-session-options'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type AgentDraftSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'agentDraft'
  | 'onAgentDraftChange'
  | 'agentSessionOptions'
  | 'quickAgent'
  | 'projectOptions'
  | 'selectedProjectId'
>

function agentDraftUnavailableReason(props: AgentDraftSectionProps): string | null {
  const target = props.projectOptions?.find((option) => option.id === props.selectedProjectId)
  if (target?.kind === 'project-group') {
    return translate(
      'auto.components.NewWorkspaceComposerModal.agentDraftFolderGroup',
      'Folder workspaces do not take an agent prompt, so this one will not be sent.'
    )
  }
  return props.quickAgent === null
    ? translate(
        'auto.components.NewWorkspaceComposerModal.agentDraftNoAgent',
        'Pick an agent to send this prompt.'
      )
    : null
}

/** Prefilled agent prompt (e.g. from a plugin task's start recipe), editable before Create;
 *  absent unless the opener prefilled one. */
export function NewWorkspaceComposerAgentDraftSection(
  props: AgentDraftSectionProps
): React.JSX.Element | null {
  const { agentDraft: value, onAgentDraftChange: onChange } = props
  const inputId = React.useId()
  const helpId = React.useId()
  if (value == null || !onChange) {
    return null
  }
  const unavailableReason = agentDraftUnavailableReason(props)
  const sessionNote = describePluginTaskSessionOptions(props.agentSessionOptions, props.quickAgent)
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
