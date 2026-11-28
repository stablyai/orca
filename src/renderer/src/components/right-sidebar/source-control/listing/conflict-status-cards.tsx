import React from 'react'
import { GitMerge, Sparkles, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

// Conflicts with no operation Git can continue or abort (e.g. a stash pop); paused operations use the header bar.
export function ConflictSummaryCard({
  unresolvedCount,
  sourceControlAiActionsVisible,
  isRecoveryBusy = false,
  onResolveWithAI,
  onReview
}: {
  unresolvedCount: number
  sourceControlAiActionsVisible: boolean
  isRecoveryBusy?: boolean
  onResolveWithAI: () => void
  onReview: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const operationLabel = t(
    'auto.components.right.sidebar.source.control.conflict.status.cards.bdf8772106',
    'Conflicts'
  )

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground" aria-live="polite">
            {t(
              'auto.components.right.sidebar.SourceControl.d7a5942e41',
              '{{value0}}: {{value1}} unresolved',
              { value0: operationLabel, value1: unresolvedCount }
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t(
              'auto.components.right.sidebar.SourceControl.3eeccbb221',
              'Resolved files move back to normal changes after they leave the live conflict state.'
            )}
          </div>
        </div>
      </div>
      <div className="mt-2">
        {sourceControlAiActionsVisible ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 w-full text-xs"
            disabled={isRecoveryBusy}
            onClick={onResolveWithAI}
          >
            <Sparkles className="size-3.5" />
            {t('auto.components.right.sidebar.SourceControl.f6cb48b6fe', 'Resolve with AI')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(sourceControlAiActionsVisible && 'mt-1.5', 'h-7 w-full text-xs')}
          onClick={onReview}
        >
          <GitMerge className="size-3.5" />
          {t('auto.components.right.sidebar.SourceControl.27a50fe970', 'Review conflicts')}
        </Button>
      </div>
    </div>
  )
}
