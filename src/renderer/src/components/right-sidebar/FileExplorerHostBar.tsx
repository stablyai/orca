import React from 'react'
import { FolderGit2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { RemoteFileBrowserBreadcrumbs } from '../sidebar/RemoteFileBrowserBreadcrumbs'
import type { FileExplorerHostMode } from './use-file-explorer-host-mode'

export function FileExplorerHostBar({
  hostMode
}: {
  hostMode: FileExplorerHostMode
}): React.JSX.Element {
  const { browser, hostLabel, exit: onReturnToProject } = hostMode
  const returnLabel = translate('fileExplorer.host.returnToProject', 'Return to workspace root')
  const refreshLabel = translate('fileExplorer.host.refresh', 'Refresh folder')
  return (
    <div
      className="shrink-0 border-b border-border px-2"
      data-file-explorer-host-bar=""
      data-ignore-file-explorer-keys="true"
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={returnLabel}
              onClick={onReturnToProject}
            >
              <FolderGit2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{returnLabel}</TooltipContent>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={hostLabel}>
          {translate('fileExplorer.host.browsing', 'Host: {{host}}', { host: hostLabel })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={refreshLabel}
              disabled={browser.loading}
              onClick={browser.refresh}
            >
              {browser.showLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{refreshLabel}</TooltipContent>
        </Tooltip>
      </div>
      {browser.listing ? (
        <RemoteFileBrowserBreadcrumbs
          resolvedPath={browser.listing.resolvedPath}
          pathFlavor={browser.listing.pathFlavor}
          loading={browser.loading}
          navigate={browser.navigate}
          navigateUp={browser.navigateUp}
        />
      ) : (
        // Why: reserve the breadcrumb row so the first listing does not grow the bar again.
        <div className="min-h-[28px]" />
      )}
    </div>
  )
}
