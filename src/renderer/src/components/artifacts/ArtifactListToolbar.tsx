import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { ArtifactListSearchField } from './ArtifactListSearchField'

export function ArtifactListToolbar({
  query,
  onQueryChange,
  onRefresh,
  isRefreshing
}: {
  query: string
  onQueryChange: (query: string) => void
  onRefresh: () => void
  isRefreshing: boolean
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ArtifactListSearchField
        query={query}
        className="w-56"
        onQueryChange={onQueryChange}
        onClear={() => onQueryChange('')}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
            onClick={onRefresh}
            disabled={isRefreshing}
            className="shrink-0 border border-border bg-background shadow-none hover:bg-muted/50"
          >
            <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
