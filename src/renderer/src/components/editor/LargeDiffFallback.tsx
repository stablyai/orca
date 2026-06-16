import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'

type LargeDiffFallbackProps = {
  filePath: string
  renderLimit: Extract<LargeDiffRenderLimit, { limited: true }>
  action?: {
    label: string
    description?: string
    onClick: () => void
  }
}

const numberFormatter = new Intl.NumberFormat()

function formatCount(value: number): string {
  return numberFormatter.format(value)
}

function formatLineCount(
  renderLimit: Extract<LargeDiffRenderLimit, { limited: true }>,
  side: 'original' | 'modified'
): string {
  if (!renderLimit.lineCounts) {
    return translate('auto.components.editor.LargeDiffFallback.7944ed9fb8', 'Not counted')
  }
  const suffix = renderLimit.lineCountsAreMinimum?.[side] ? '+' : ''
  return `${formatCount(renderLimit.lineCounts[side])}${suffix}`
}

export function LargeDiffFallback({
  filePath,
  renderLimit,
  action
}: LargeDiffFallbackProps): React.JSX.Element {
  const reason =
    renderLimit.reason === 'line-count'
      ? translate(
          'auto.components.editor.LargeDiffFallback.a3c74f8a21',
          'line count exceeds the safe display limit'
        )
      : translate(
          'auto.components.editor.LargeDiffFallback.fd92fbde46',
          'character count exceeds the safe display limit'
        )

  return (
    <div
      data-testid="large-diff-fallback"
      className="flex h-full min-h-[120px] items-center justify-center border border-border bg-muted/10 px-4 py-6 text-muted-foreground"
    >
      <div className="max-w-xl space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.LargeDiffFallback.7d424bb761',
            'This diff is too large to display safely.'
          )}
        </div>
        <div className="break-all text-xs">{filePath}</div>
        <div className="grid gap-1 text-xs sm:grid-cols-2 sm:text-left">
          <div>
            {translate('auto.components.editor.LargeDiffFallback.28aa2cc90b', 'Original lines')}:{' '}
            {formatLineCount(renderLimit, 'original')}
          </div>
          <div>
            {translate('auto.components.editor.LargeDiffFallback.20857938dd', 'Modified lines')}:{' '}
            {formatLineCount(renderLimit, 'modified')}
          </div>
          <div>
            {translate('auto.components.editor.LargeDiffFallback.e5f0d2182e', 'Characters')}:{' '}
            {formatCount(renderLimit.characterCount)}
          </div>
          <div>
            {translate('auto.components.editor.LargeDiffFallback.877c25a02f', 'Reason')}: {reason}
          </div>
        </div>
        <div className="text-[11px]">
          {translate('auto.components.editor.LargeDiffFallback.5fca073b72', 'Limits')}:{' '}
          {formatCount(renderLimit.limits.maxLinesPerSide)}{' '}
          {translate('auto.components.editor.LargeDiffFallback.f1d136a163', 'lines per side')} ·{' '}
          {formatCount(renderLimit.limits.maxCombinedCharacters)}{' '}
          {translate('auto.components.editor.LargeDiffFallback.23433fcdea', 'combined characters')}
        </div>
        {action ? (
          <div className="space-y-2">
            {action.description ? <div className="text-[11px]">{action.description}</div> : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                action.onClick()
              }}
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
