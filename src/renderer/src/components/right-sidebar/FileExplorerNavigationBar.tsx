import { useLayoutEffect, useMemo, useRef } from 'react'
import { ArrowUp, FolderOpen } from 'lucide-react'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  getCollapsedExplorerBreadcrumbs,
  type ExplorerBreadcrumb
} from './file-explorer-display-root'

export type FileExplorerNavigation = {
  breadcrumbs: ExplorerBreadcrumb[]
  outsideWorkspace: boolean
  localOnlyDisabled: boolean
  onNavigate: (path: string) => void
  onUp: () => void
  onOpenFolder: () => void
  onBackToWorkspace: () => void
}

function shouldRenderBreadcrumbSeparator(
  breadcrumbs: readonly ExplorerBreadcrumb[],
  index: number
): boolean {
  if (index <= 0) {
    return false
  }
  const previous = breadcrumbs[index - 1]
  return !previous.label.endsWith('/') && !previous.label.endsWith('\\')
}

export function FileExplorerNavigationBar({
  navigation
}: {
  navigation?: FileExplorerNavigation
}): React.JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null)

  const breadcrumbs = navigation?.breadcrumbs
  const displayBreadcrumbs = useMemo(
    () => (breadcrumbs ? getCollapsedExplorerBreadcrumbs(breadcrumbs) : []),
    [breadcrumbs]
  )

  // Why: keep the current folder scrolled into view in narrow sidebars when paths overflow.
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [displayBreadcrumbs])

  if (!navigation) {
    return null
  }
  return (
    <div className="border-b border-border">
      <div className="flex min-h-8 min-w-0 items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={navigation.localOnlyDisabled}
              aria-label={translate('fileExplorer.navigation.up', 'Up')}
              onClick={navigation.onUp}
            >
              <ArrowUp />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{translate('fileExplorer.navigation.up', 'Up')}</TooltipContent>
        </Tooltip>
        <div
          ref={scrollRef}
          className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none"
        >
          {displayBreadcrumbs.map((segment, index) => (
            <div
              key={segment.label === '…' ? `ellipsis:${segment.path}` : segment.path}
              className="flex shrink-0 items-center"
            >
              {shouldRenderBreadcrumbSeparator(displayBreadcrumbs, index) && (
                <span className="text-xs text-muted-foreground">/</span>
              )}
              {segment.label === '…' ? (
                <span className="px-1 text-xs text-muted-foreground select-none" aria-hidden="true">
                  …
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={navigation.localOnlyDisabled}
                  onClick={() => navigation.onNavigate(segment.path)}
                >
                  {segment.label}
                </Button>
              )}
            </div>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={navigation.localOnlyDisabled}
              aria-label={translate('fileExplorer.navigation.openFolder', 'Open Folder…')}
              onClick={navigation.onOpenFolder}
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('fileExplorer.navigation.openFolder', 'Open Folder…')}
          </TooltipContent>
        </Tooltip>
        {navigation.localOnlyDisabled && <LocalOnlyMenuHint />}
      </div>
      {navigation.outsideWorkspace && (
        <div className="flex min-h-8 items-center gap-2 border-t border-border bg-muted/40 px-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {translate(
              'fileExplorer.navigation.outsideWorkspace',
              'Outside the workspace · read-only'
            )}
          </span>
          <Button variant="outline" size="xs" onClick={navigation.onBackToWorkspace}>
            {translate('fileExplorer.navigation.backToWorkspace', 'Back to workspace')}
          </Button>
        </div>
      )}
    </div>
  )
}
