import type React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'

type SkippedConflicts = NonNullable<OpenFile['skippedConflicts']>

export function CombinedDiffSkippedConflictsEmptyState({
  commitHeader,
  onReviewConflicts,
  skippedConflicts
}: {
  commitHeader: React.ReactNode
  onReviewConflicts: () => void
  skippedConflicts: SkippedConflicts
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-full min-h-0 flex-col">
      {commitHeader}
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <div className="text-sm font-medium text-foreground">
            {t(
              'auto.components.editor.CombinedDiffViewer.820ec01f24',
              'Conflicted files are reviewed separately'
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {t(
              'auto.components.editor.CombinedDiffViewer.eb5f40e49c',
              'This diff view excludes unresolved conflicts because the normal two-way diff pipeline is not conflict-safe.'
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {skippedConflicts.map((entry) => entry.path).join(', ')}
          </div>
          <div className="flex justify-center">
            <Button type="button" size="sm" variant="outline" onClick={onReviewConflicts}>
              {t('auto.components.editor.CombinedDiffViewer.39f8007549', 'Review conflicts')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CombinedDiffNoChangesEmptyState({
  commitHeader
}: {
  commitHeader: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-full min-h-0 flex-col">
      {commitHeader}
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('auto.components.editor.CombinedDiffViewer.fd8892b120', 'No changes to display')}
      </div>
    </div>
  )
}

export function CombinedDiffSkippedConflictNotice({
  onReviewConflicts,
  skippedConflicts
}: {
  onReviewConflicts: () => void
  skippedConflicts: SkippedConflicts
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mx-4 mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      <div className="font-medium text-foreground">
        {t(
          'auto.components.editor.CombinedDiffViewer.820ec01f24',
          'Conflicted files are reviewed separately'
        )}
      </div>
      <div className="mt-1 text-muted-foreground">
        {t(
          'auto.components.editor.CombinedDiffViewer.skippedConflictsExcluded',
          '{{count}} unresolved conflicts were excluded from this diff view.',
          {
            count: skippedConflicts.length,
            defaultValue_one: '{{count}} unresolved conflict was excluded from this diff view.'
          }
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onReviewConflicts}
        >
          {t('auto.components.editor.CombinedDiffViewer.39f8007549', 'Review conflicts')}
        </Button>
      </div>
    </div>
  )
}
