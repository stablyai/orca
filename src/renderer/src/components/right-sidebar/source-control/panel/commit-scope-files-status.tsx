import type React from 'react'
import { Button } from '@/components/ui/button'
import type { Translate } from '@/i18n/use-translate'
import type { SourceControlCommitScopeFiles } from './change-scope'

/** Undefined lets the section render its rows. */
export function commitScopeFilesStatus(
  t: Translate,
  files: SourceControlCommitScopeFiles | null,
  rowsOrFilterNotice: boolean,
  onRetry: () => void
): React.JSX.Element | undefined {
  if (!files || files.status === 'loading') {
    return <div className="h-6" aria-busy="true" />
  }
  if (files.status === 'error') {
    return (
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
        <span title={files.error}>
          {t(
            'auto.components.right.sidebar.SourceControl.scopeFilesFailed',
            "Couldn't load files."
          )}
        </span>
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="text-theme-accent"
          onClick={onRetry}
        >
          {t('auto.components.right.sidebar.SourceControl.scopeRetryCommits', 'Retry')}
        </Button>
      </div>
    )
  }
  // The content status already explains a filter that hides every row.
  if (rowsOrFilterNotice) {
    return undefined
  }
  return (
    <div className="px-4 py-2 text-xs text-muted-foreground">
      {t(
        'auto.components.right.sidebar.GitHistoryCommitFiles.b2c3d4e5f6',
        'No file changes in this commit'
      )}
    </div>
  )
}
