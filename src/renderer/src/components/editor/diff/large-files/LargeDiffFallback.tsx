import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { LargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'

type LargeDiffFallbackProps = {
  filePath: string
  renderLimit: Extract<LargeDiffRenderLimit, { limited: true }>
  action?: {
    label: string
    description?: string
    onClick: () => void
  }
}

const NUMBER_OPTIONS: Intl.NumberFormatOptions = {}

function formatCount(value: number, intlLocale?: string): string {
  return uiNumberFormat(NUMBER_OPTIONS, intlLocale).format(value)
}

function formatLineCount(
  renderLimit: Extract<LargeDiffRenderLimit, { limited: true }>,
  side: 'original' | 'modified',
  t: Translate = translate,
  intlLocale?: string
): string {
  if (!renderLimit.lineCounts) {
    return t('auto.components.editor.LargeDiffFallback.7944ed9fb8', 'Not counted')
  }
  const suffix = renderLimit.lineCountsAreMinimum?.[side] ? '+' : ''
  return `${formatCount(renderLimit.lineCounts[side], intlLocale)}${suffix}`
}

export function LargeDiffFallback({
  filePath,
  renderLimit,
  action
}: LargeDiffFallbackProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const reason =
    renderLimit.reason === 'line-count'
      ? t(
          'auto.components.editor.LargeDiffFallback.a3c74f8a21',
          'line count exceeds the safe display limit'
        )
      : t(
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
          {t(
            'auto.components.editor.LargeDiffFallback.7d424bb761',
            'This diff is too large to display safely.'
          )}
        </div>
        <div className="break-all text-xs">{filePath}</div>
        <div className="grid gap-1 text-xs sm:grid-cols-2 sm:text-left">
          <div>
            {t('auto.components.editor.LargeDiffFallback.28aa2cc90b', 'Original lines')}:{' '}
            {formatLineCount(renderLimit, 'original', t, intlLocale)}
          </div>
          <div>
            {t('auto.components.editor.LargeDiffFallback.20857938dd', 'Modified lines')}:{' '}
            {formatLineCount(renderLimit, 'modified', t, intlLocale)}
          </div>
          <div>
            {t('auto.components.editor.LargeDiffFallback.e5f0d2182e', 'Characters')}:{' '}
            {formatCount(renderLimit.characterCount, intlLocale)}
          </div>
          <div>
            {t('auto.components.editor.LargeDiffFallback.877c25a02f', 'Reason')}: {reason}
          </div>
        </div>
        <div className="text-[11px]">
          {/* Both limits are large fixed values, so the plural form never varies. */}
          {t(
            'auto.components.editor.LargeDiffFallback.limitsSummary',
            'Limits: {{lines}} lines per side · {{characters}} combined characters',
            {
              lines: formatCount(renderLimit.limits.maxLinesPerSide, intlLocale),
              characters: formatCount(renderLimit.limits.maxCombinedCharacters, intlLocale)
            }
          )}
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
