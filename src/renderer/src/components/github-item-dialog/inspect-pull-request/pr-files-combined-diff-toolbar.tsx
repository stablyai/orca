import React from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { isPRFileViewed } from '@/components/github/pr-file-content-size'
import type { GitHubPRFile } from '../../../../../shared/github/pull-request-types'

export function PRFilesCombinedDiffToolbar({
  files,
  fileTreeCollapsed,
  allSectionsCollapsed,
  sideBySide,
  onShowFileTree,
  onToggleAllCollapsed,
  onToggleSideBySide
}: {
  files: GitHubPRFile[]
  fileTreeCollapsed: boolean
  allSectionsCollapsed: boolean
  sideBySide: boolean
  onShowFileTree: () => void
  onToggleAllCollapsed: () => void
  onToggleSideBySide: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {fileTreeCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.GitHubItemDialog.1257d1435d',
                  'Show file tree'
                )}
                onClick={onShowFileTree}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.GitHubItemDialog.1257d1435d', 'Show file tree')}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {files.filter(isPRFileViewed).length} / {files.length}{' '}
          {translate('auto.components.GitHubItemDialog.f2d02cdf8c', 'files viewed')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="min-w-20 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={onToggleAllCollapsed}
        >
          {allSectionsCollapsed
            ? translate('auto.components.GitHubItemDialog.3c19ec3069', 'Expand All')
            : translate('auto.components.GitHubItemDialog.d00a0a7f8f', 'Collapse All')}
        </button>
        <button
          type="button"
          className="min-w-24 rounded border border-border px-2 py-0.5 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={onToggleSideBySide}
        >
          {sideBySide
            ? translate('auto.components.GitHubItemDialog.6e43a16435', 'Inline')
            : translate('auto.components.GitHubItemDialog.31770bef03', 'Side by Side')}
        </button>
      </div>
    </div>
  )
}
