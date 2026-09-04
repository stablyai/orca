import React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerPromptSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  'agentPrompt' | 'onAgentPromptChange' | 'promptTextareaRef' | 'quickAgent'
>

export function NewWorkspaceComposerPromptSection({
  agentPrompt,
  onAgentPromptChange,
  promptTextareaRef,
  quickAgent
}: NewWorkspaceComposerPromptSectionProps): React.JSX.Element {
  const promptInputId = React.useId()
  // Why: with no agent to launch there is nothing to hand the prompt to.
  const disabled = quickAgent === null
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={promptInputId} className="text-xs font-medium text-muted-foreground">
        {translate('auto.components.NewWorkspaceComposerCard.promptLabel', 'Prompt')}
      </label>
      <Textarea
        id={promptInputId}
        ref={promptTextareaRef}
        value={agentPrompt}
        onChange={(event) => onAgentPromptChange(event.target.value)}
        disabled={disabled}
        rows={2}
        placeholder={
          disabled
            ? translate(
                'auto.components.NewWorkspaceComposerCard.promptPlaceholderNoAgent',
                'Choose an agent to send a first prompt'
              )
            : translate(
                'auto.components.NewWorkspaceComposerCard.promptPlaceholder',
                'Sent to the agent as soon as the workspace is ready'
              )
        }
        // Match the composer's other fields: transparent, 13/14px, grow to content.
        className="max-h-40 min-h-0 resize-none bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground [field-sizing:content] dark:bg-transparent"
      />
    </div>
  )
}
