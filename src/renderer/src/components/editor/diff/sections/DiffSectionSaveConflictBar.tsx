import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export const SECTION_STALE_MESSAGE = 'This file changed on disk since this section loaded.'

export function DiffSectionSaveConflictBar({
  onReload,
  onOverwrite
}: {
  onReload: () => void
  onOverwrite: () => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-status-warning-border bg-status-warning-background px-3 py-1.5 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-status-warning" />
        <span className="min-w-0 font-medium text-foreground">
          {translate(
            'auto.components.editor.editor.save.sectionStale.notice',
            SECTION_STALE_MESSAGE
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="xs" variant="outline" onClick={onReload}>
          {translate(
            'auto.components.editor.ExternalFileChangeBanner.3fa2b8d417',
            'Reload from Disk'
          )}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={onOverwrite}>
          {translate('auto.components.editor.ExternalFileChangeBanner.overwrite', 'Overwrite')}
        </Button>
      </div>
    </div>
  )
}
