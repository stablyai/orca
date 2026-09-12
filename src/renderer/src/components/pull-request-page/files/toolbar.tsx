import React from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isPRFileViewed } from '@/components/github/pr-file-content-size'
import { translate } from '@/i18n/i18n'
import type { GitHubPRFile } from '../../../../../shared/github/pull-request-types'

export function PRFilesDiffToolbar({
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
    <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {fileTreeCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.PullRequestPage.319cf2d54b',
                  'Show file tree'
                )}
                onClick={onShowFileTree}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.PullRequestPage.319cf2d54b', 'Show file tree')}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {files.filter(isPRFileViewed).length} / {files.length}{' '}
          {translate('auto.components.PullRequestPage.89e80af1c7', 'files viewed')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-20 justify-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={onToggleAllCollapsed}
        >
          {allSectionsCollapsed
            ? translate('auto.components.PullRequestPage.eb722a5a8c', 'Expand All')
            : translate('auto.components.PullRequestPage.dd94111c18', 'Collapse All')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-24 justify-center text-muted-foreground shadow-none hover:text-foreground"
          onClick={onToggleSideBySide}
        >
          {sideBySide
            ? translate('auto.components.PullRequestPage.e5f4a24f78', 'Inline')
            : translate('auto.components.PullRequestPage.1378d79e83', 'Side by Side')}
        </Button>
      </div>
    </div>
  )
}
