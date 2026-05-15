import React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type FileExplorerToolbarProps = {
  repoName: string
  refresh: {
    isRefreshing: boolean
    showRefreshSpinner: boolean
    handleRefresh: () => void
  }
}

export function FileExplorerToolbar({
  repoName,
  refresh
}: FileExplorerToolbarProps): React.JSX.Element {
  return (
    <div className="flex h-8 min-h-8 items-center gap-2 border-b border-border px-2">
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
        title={repoName}
      >
        {repoName}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Refresh Explorer"
            disabled={refresh.isRefreshing}
            onClick={refresh.handleRefresh}
          >
            {refresh.showRefreshSpinner ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          Refresh Explorer
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
