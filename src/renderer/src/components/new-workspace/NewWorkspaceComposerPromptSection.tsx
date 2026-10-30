import React, { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { ImeTextarea } from '@/lib/ime-text-field'
import { translate } from '@/i18n/i18n'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerPromptSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  'agentPrompt' | 'onAgentPromptChange' | 'quickAgent' | 'createDisabled' | 'onCreate'
> & {
  /** Compact controls rendered inside the box under the text, like the chat composer. */
  toolbar: React.ReactNode
}

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
    if (event.shiftKey || isImeOwnedKeyboardEvent(event)) {
      return
    }
    // Why: plain Enter fires the task like the chat composer; Shift+Enter keeps the newline.
    event.preventDefault()
    if (!createDisabled) {
      onCreate()
    }
  }
  const disabled = quickAgent === null
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const wasDisabledRef = useRef(disabled)
  useEffect(() => {
    const becameEnabled = wasDisabledRef.current && !disabled
    wasDisabledRef.current = disabled
    // Why: initial focus skipped the disabled prompt; claim it once enabled unless the user moved focus elsewhere.
    const focused = document.activeElement
    if (
      becameEnabled &&
      (focused === null ||
        focused === document.body ||
        focused.matches('[data-workspace-name-input="true"]'))
    ) {
      promptRef.current?.focus({ preventScroll: true })
    }
  }, [disabled])
  return (
    <div
      // Why: the same frame as the native chat composer, since the prompt becomes its first message.
      className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs"
    >
      <ImeTextarea
        ref={promptRef}
        data-workspace-prompt-input="true"
        aria-label={translate('auto.components.NewWorkspaceComposerCard.promptLabel', 'Prompt')}
        value={agentPrompt}
        disabled={disabled}
        onChange={(event) => onAgentPromptChange?.(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
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
          'min-h-12 w-full resize-none bg-transparent px-2 py-1 text-sm text-chat-foreground-strong outline-none pointer-coarse:min-h-14',
          'max-h-[calc(8lh+0.5rem)] overflow-y-auto scrollbar-sleek',
          'placeholder:text-chat-foreground-faint disabled:cursor-not-allowed disabled:opacity-50'
        )}
      />
      <div className="flex items-center gap-1 pt-0.5">{toolbar}</div>
    </div>
  )
}
