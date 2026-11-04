import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { SearchQueryRow, type SearchQueryRowProps } from './SearchQueryRow'
import { SearchReplaceRow, type SearchReplaceRowProps } from './SearchReplaceRow'

type SearchQueryWithReplaceProps = {
  queryRowProps: SearchQueryRowProps
  replaceRowProps: SearchReplaceRowProps
  replaceVisible: boolean
  onToggleReplace: () => void
}

export function SearchQueryWithReplace({
  queryRowProps,
  replaceRowProps,
  replaceVisible,
  onToggleReplace
}: SearchQueryWithReplaceProps): React.JSX.Element {
  const toggleLabel = translate(
    'auto.components.right.sidebar.SearchReplace.toggle',
    'Toggle Replace'
  )
  return (
    <div className="flex items-stretch gap-0.5 text-muted-foreground">
      {/* Why: like VS Code, the chevron spans both inputs so it reads as expanding the search box. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-auto w-4 shrink-0"
            aria-label={toggleLabel}
            aria-expanded={replaceVisible}
            onClick={onToggleReplace}
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', replaceVisible && 'rotate-90')}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {toggleLabel}
        </TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <SearchQueryRow {...queryRowProps} />
        {replaceVisible ? <SearchReplaceRow {...replaceRowProps} /> : null}
      </div>
    </div>
  )
}
