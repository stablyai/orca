import { RefreshCw, Sparkles, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function CreatePullRequestGenerateButton({
  generating,
  generateDisabled,
  generateDisabledReason,
  shortLabel,
  reviewLabel,
  onGenerate,
  onCancelGenerate
}: {
  generating: boolean
  generateDisabled: boolean
  generateDisabledReason: string | null | undefined
  shortLabel: 'PR' | 'MR'
  reviewLabel: 'pull request' | 'merge request'
  onGenerate: () => void
  onCancelGenerate: () => void
}): React.JSX.Element {
  if (generating) {
    return (
      <div className="shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancelGenerate}
              title="Stop generating"
              aria-label={`Stop generating ${reviewLabel} details`}
            >
              <RefreshCw className="size-4 animate-spin" />
              Generating…
              <Square className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            Generating {shortLabel} details. Click to stop.
          </TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={generateDisabled}
        onClick={onGenerate}
        title={generateDisabledReason ?? `Generate ${reviewLabel} details with AI`}
        aria-label={`Generate ${reviewLabel} details with AI`}
      >
        <Sparkles className="size-4" />
        Generate with AI
      </Button>
    </div>
  )
}
