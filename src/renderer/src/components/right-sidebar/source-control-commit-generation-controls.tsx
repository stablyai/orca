import React from 'react'
import { RefreshCw, Sparkles, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function getCommitGenerationDisabledReason({
  isGenerating,
  isCommitting,
  aiAgentConfigured,
  stagedCount,
  hasMessage
}: {
  isGenerating: boolean
  isCommitting: boolean
  aiAgentConfigured: boolean
  stagedCount: number
  hasMessage: boolean
}): string | undefined {
  if (isGenerating) {
    return translate(
      'auto.components.right.sidebar.SourceControl.2a9ea1d3f6',
      'Generating commit message…'
    )
  }
  if (isCommitting) {
    return translate(
      'auto.components.right.sidebar.SourceControl.6d59e0896d',
      'Commit in progress…'
    )
  }
  if (!aiAgentConfigured) {
    return translate(
      'auto.components.right.sidebar.SourceControl.833876a999',
      'Pick an agent in Settings -> Git -> Source Control AI.'
    )
  }
  if (stagedCount === 0) {
    return translate(
      'auto.components.right.sidebar.SourceControl.52f2f5137d',
      'Stage at least one file to generate a message.'
    )
  }
  if (hasMessage) {
    return translate(
      'auto.components.right.sidebar.SourceControl.b60ea73cbf',
      'Clear the message to regenerate.'
    )
  }
  return undefined
}

export function CommitGenerationControl({
  isGenerating,
  isGenerateDisabled,
  generateDisabledReason,
  onGenerate,
  onCancelGenerate
}: {
  isGenerating: boolean
  isGenerateDisabled: boolean
  generateDisabledReason?: string
  onGenerate: () => void
  onCancelGenerate: () => void
}): React.JSX.Element {
  return isGenerating ? (
    // Why: while generating the icon doubles as the cancel affordance.
    // Default state shows the spinning RefreshCw; on hover/focus we
    // swap to a Square ("stop") with a destructive tint so the user
    // sees that clicking will abort the run. Group/group-hover toggles
    // keep this stateless on the React side.
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onCancelGenerate()}
          title={translate(
            'auto.components.right.sidebar.SourceControl.527e130b6f',
            'Stop generating'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.ddc1fbd690',
            'Stop generating commit message'
          )}
          className="group absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40"
        >
          <RefreshCw className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
          <Square className="hidden size-3.5 fill-current group-hover:block group-focus-visible:block" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {translate(
          'auto.components.right.sidebar.SourceControl.37a81f29ad',
          'Generating commit message. Click to stop.'
        )}
      </TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={isGenerateDisabled}
          onClick={(event) => {
            if (isGenerateDisabled) {
              event.preventDefault()
              return
            }
            onGenerate()
          }}
          title={
            generateDisabledReason ??
            translate('auto.components.right.sidebar.SourceControl.b16b8f0e4b', 'ai commit msg')
          }
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.461575b9bc',
            'Generate commit message with AI'
          )}
          className={cn(
            'absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isGenerateDisabled &&
              'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
          )}
        >
          <Sparkles className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {generateDisabledReason ??
          translate('auto.components.right.sidebar.SourceControl.b16b8f0e4b', 'ai commit msg')}
      </TooltipContent>
    </Tooltip>
  )
}
