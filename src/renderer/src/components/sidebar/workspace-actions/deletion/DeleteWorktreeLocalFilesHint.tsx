import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { formatAtRiskLocalFileNames } from '@/lib/workspace/display/at-risk-local-files-label'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/at-risk-local-files'

export function DeleteWorktreeLocalFilesHint({
  files
}: {
  files: WorktreeAtRiskLocalFiles | undefined
}): JSX.Element | null {
  const t = useTranslate()
  if (!files) {
    return null
  }
  const names = formatAtRiskLocalFileNames(files, t)
  const label = names
    ? t('components.workspace.delete.ignoredFilesLost', 'Ignored files will be lost: {{names}}', {
        names
      })
    : t(
        'components.workspace.delete.ignoredFilesUnchecked',
        'Ignored files could not be fully checked'
      )
  return (
    <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-destructive" title={label}>
      <AlertTriangle className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-medium">{label}</span>
    </div>
  )
}
