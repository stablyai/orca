import { RefreshCw, Sparkles, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

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
              title={translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.e041998cad", "Stop generating")}
              aria-label={translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.e041998cad", "Stop generating {{value0}} details", { value0: reviewLabel })}
            >
              <RefreshCw className="size-4 animate-spin" />
              {translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.a6ea6dc3aa", "Generating…")}<Square className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            {translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.f5513bdeb1", "Generating")}{shortLabel} {translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.d47fd63012", "details. Click to stop.")}</TooltipContent>
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
        title={generateDisabledReason ?? translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.a0501572c1", "Generate {{value0}} details with AI", { value0: reviewLabel })}
        aria-label={translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.a0501572c1", "Generate {{value0}} details with AI", { value0: reviewLabel })}
      >
        <Sparkles className="size-4" />
        {translate("auto.components.right.sidebar.CreatePullRequestGenerateButton.4012459f8a", "Generate with AI")}</Button>
    </div>
  )
}
