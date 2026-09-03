import type { RefObject } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { isCombinedDiffSizeUnknown } from './combined-diff-on-demand-load'
import type { DiffSection } from './diff-section-types'
import { translate } from '@/i18n/i18n'
import { LargeDiffFallback } from './LargeDiffFallback'
import { LargeDiffLoadPrompt } from './LargeDiffLoadPrompt'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

type DiffSectionBodyProps = {
  section: DiffSection
  index: number
  sectionBodyRef: RefObject<HTMLDivElement | null>
  sectionBodyHeight: number | undefined
  useIntrinsicImageHeight: boolean
  isBranchMode: boolean
  sideBySide: boolean
  isEditable: boolean
  /** Renders the text diff itself; kept as a callback so this file owns only the branching. */
  renderDiff: () => React.ReactNode
  onRetrySection: (index: number) => void
  onLoadDeferredSection: (index: number) => void
  onSaveLimitedDiff: () => void
}

export function DiffSectionBody({
  section,
  index,
  sectionBodyRef,
  sectionBodyHeight,
  useIntrinsicImageHeight,
  isBranchMode,
  sideBySide,
  isEditable,
  renderDiff,
  onRetrySection,
  onLoadDeferredSection,
  onSaveLimitedDiff
}: DiffSectionBodyProps): React.JSX.Element {
  const renderLimit = section.largeDiffRenderLimit?.limited ? section.largeDiffRenderLimit : null

  return (
    <div
      ref={sectionBodyRef}
      className={cn('relative', useIntrinsicImageHeight && 'overflow-visible')}
      style={sectionBodyHeight === undefined ? undefined : { height: sectionBodyHeight }}
    >
      {section.loadOnDemand ? (
        <LargeDiffLoadPrompt
          sizeUnknown={isCombinedDiffSizeUnknown(section)}
          onLoad={() => onLoadDeferredSection(index)}
        />
      ) : section.loading ? (
        <div className="flex h-full items-center gap-2 bg-muted/10 px-3 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
          <span>
            {translate('auto.components.editor.DiffSectionBody.f5cf81cec2', 'Loading diff...')}
          </span>
        </div>
      ) : section.error ? (
        <div className="flex h-full items-center justify-between gap-3 bg-muted/10 px-3 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            <span className="truncate">{section.error}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={(event) => {
              event.stopPropagation()
              onRetrySection(index)
            }}
          >
            <RefreshCw className="size-3" />
            {translate('auto.components.editor.DiffSectionBody.cef4cf0ff5', 'Retry')}
          </Button>
        </div>
      ) : section.diffResult?.kind === 'binary' ? (
        section.diffResult.isImage ? (
          <ImageDiffViewer
            originalContent={section.diffResult.originalContent}
            modifiedContent={section.diffResult.modifiedContent}
            filePath={section.path}
            mimeType={section.diffResult.mimeType}
            sideBySide={sideBySide}
            layout={useIntrinsicImageHeight ? 'intrinsic' : 'fill'}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">
                {translate(
                  'auto.components.editor.DiffSectionBody.35d6afb5be',
                  'Binary file changed'
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {isBranchMode
                  ? translate(
                      'auto.components.editor.DiffSectionBody.7ce8436458',
                      'Text diff is unavailable for this file in branch compare.'
                    )
                  : translate(
                      'auto.components.editor.DiffSectionBody.72f71f52eb',
                      'Text diff is unavailable for this file.'
                    )}
              </div>
            </div>
          </div>
        )
      ) : renderLimit?.limited ? (
        <LargeDiffFallback
          filePath={section.path}
          renderLimit={renderLimit}
          action={
            isEditable && section.dirty
              ? {
                  label: translate('auto.components.editor.DiffSectionBody.b5675b0694', 'Save'),
                  description: translate(
                    'auto.components.editor.DiffSectionBody.593f2193f6',
                    'This draft crossed the safe display limit, but it can still be saved.'
                  ),
                  onClick: onSaveLimitedDiff
                }
              : undefined
          }
        />
      ) : (
        renderDiff()
      )}
    </div>
  )
}
