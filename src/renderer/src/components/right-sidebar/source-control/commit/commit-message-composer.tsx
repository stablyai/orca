import React from 'react'
import { RefreshCw, Sparkles, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function CommitMessageComposer({
  rows,
  commitMessage,
  disabled,
  onCommitMessageChange,
  describedBy,
  showGenerate,
  isGenerating,
  onCancelGenerate,
  isGenerateDisabled,
  onGenerate,
  generateTooltip
}: {
  rows: number
  commitMessage: string
  disabled: boolean
  onCommitMessageChange: (message: string) => void
  describedBy: string
  showGenerate: boolean
  isGenerating: boolean
  onCancelGenerate: () => void
  isGenerateDisabled: boolean
  onGenerate: () => void
  generateTooltip?: string
}): React.JSX.Element {
  return (
    <div className="relative">
      <textarea
        rows={rows}
        value={commitMessage}
        disabled={disabled}
        onChange={(e) => onCommitMessageChange(e.target.value)}
        placeholder={translate('auto.components.right.sidebar.SourceControl.0d0a8359d3', 'Message')}
        aria-label={translate(
          'auto.components.right.sidebar.SourceControl.b94112eb9e',
          'Commit message'
        )}
        aria-describedby={describedBy || undefined}
        // Why: reserve right padding so text doesn't slide under the absolute-positioned Generate icon.
        // Why: pin disabled:border-input so Chromium's UA disabled styles don't wash out the field outline.
        className={`mt-0.5 min-h-14 w-full resize-none appearance-none rounded-md border border-input bg-background shadow-xs px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-input disabled:bg-background disabled:text-foreground disabled:shadow-xs dark:bg-input/30 dark:disabled:bg-input/30 ${
          showGenerate ? 'pr-8' : ''
        }`}
      />
      {showGenerate &&
        (isGenerating ? (
          // Why: while generating, the icon doubles as cancel — hover/focus swaps the spinner to a destructive Square via CSS group toggles (stateless in React).
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
                  generateTooltip ??
                  translate(
                    'auto.components.right.sidebar.SourceControl.b16b8f0e4b',
                    'ai commit msg'
                  )
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
              {generateTooltip ??
                translate(
                  'auto.components.right.sidebar.SourceControl.b16b8f0e4b',
                  'ai commit msg'
                )}
            </TooltipContent>
          </Tooltip>
        ))}
    </div>
  )
}
