import { ArrowLeft, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { FileExplorerRootSelect, type FileExplorerRootSelectProps } from './FileExplorerRootSelect'
import type { ExplorerRootOption } from './file-explorer-display-root'

export function FileExplorerScopeNotice({
  rootSelect,
  returnRoot,
  onSelectRoot,
  disabled,
  searching,
  sparse
}: {
  rootSelect?: FileExplorerRootSelectProps | null
  returnRoot: ExplorerRootOption | null
  onSelectRoot: (value: string) => void
  disabled: boolean
  searching: boolean
  sparse: boolean
}): React.JSX.Element | null {
  if (!sparse) {
    return null
  }
  return (
    <div className="border-b border-border">
      <div className="flex min-h-8 min-w-0 items-center gap-1 px-2">
        {returnRoot && !searching && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={translate('fileExplorer.root.back', 'Back to {{path}}', {
                  path: returnRoot.label
                })}
                onClick={() => onSelectRoot(returnRoot.value)}
              >
                <ArrowLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('fileExplorer.root.back', 'Back to {{path}}', { path: returnRoot.label })}
            </TooltipContent>
          </Tooltip>
        )}
        {rootSelect && !searching ? (
          <FileExplorerRootSelect {...rootSelect} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {searching
              ? translate('fileExplorer.root.searchScope', 'Search scope: workspace files')
              : translate('fileExplorer.root.sparseStatus', 'Sparse checkout')}
          </span>
        )}
        <div className="ml-auto shrink-0">
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'fileExplorer.root.scopeDetails',
                      'About sparse checkout scope'
                    )}
                  >
                    <Info />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>
                {translate('fileExplorer.root.scopeDetails', 'About sparse checkout scope')}
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              align="end"
              collisionPadding={8}
              className="w-72 max-w-[var(--radix-popover-content-available-width)]"
            >
              <div className="space-y-2 p-3 text-xs">
                <p className="font-medium">
                  {translate('fileExplorer.root.sparseStatus', 'Sparse checkout')}
                </p>
                <p>
                  {translate(
                    'fileExplorer.root.scopeExplanation',
                    'The folder picker changes what you see, not which files are checked out. Repository root includes the checked-out root and ancestor files.'
                  )}
                </p>
                <p className="text-muted-foreground">
                  {translate(
                    'fileExplorer.root.searchExplanation',
                    'Names filters the folder you are viewing. Contents searches across the workspace. Files omitted by sparse checkout are not searched.'
                  )}
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
