import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerPromptSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  'agentPrompt' | 'onAgentPromptChange' | 'quickAgent' | 'createDisabled' | 'onCreate'
> & {
  /** Compact controls rendered inside the box under the text, like the chat composer. */
  toolbar: React.ReactNode
}

/**
 * Chat-composer style box: the prompt is the input, and everything the prompt
 * runs against sits in a toolbar inside the same frame.
 */
export function NewWorkspaceComposerPromptSection({
  agentPrompt = '',
  onAgentPromptChange,
  quickAgent,
  createDisabled,
  onCreate,
  toolbar
}: NewWorkspaceComposerPromptSectionProps): React.JSX.Element {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }
    if (shouldSuppressEnterSubmit(event.nativeEvent, true)) {
      return
    }
    // Why: plain Enter fires the task like the chat composer; Shift+Enter keeps the newline.
    event.preventDefault()
    if (!createDisabled) {
      onCreate()
    }
  }
  const disabled = quickAgent === null
  return (
    <div
      data-contextual-tour-target="workspace-creation-prompt"
      className={cn(
        'rounded-lg border border-border p-1.5 shadow-xs',
        'bg-muted/50 dark:bg-input/40'
      )}
    >
      <textarea
        data-workspace-prompt-input="true"
        aria-label={translate('auto.components.NewWorkspaceComposerCard.promptLabel', 'Prompt')}
        value={agentPrompt}
        disabled={disabled}
        onChange={(event) => onAgentPromptChange?.(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={5}
        placeholder={
          disabled
            ? translate(
                'auto.components.NewWorkspaceComposerCard.promptPlaceholderNoAgent',
                'Pick an agent to send it a prompt'
              )
            : translate(
                'auto.components.NewWorkspaceComposerCard.promptPlaceholder',
                'What should the agent do in this worktree?'
              )
        }
        className={cn(
          'min-h-32 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none',
          'max-h-[calc(8lh+0.5rem)] overflow-y-auto scrollbar-sleek',
          'placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50'
        )}
      />
      <div className="flex items-center gap-1 pt-0.5">{toolbar}</div>
    </div>
  )
}
