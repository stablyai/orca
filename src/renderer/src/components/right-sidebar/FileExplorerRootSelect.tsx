import { ChevronDown, ChevronRight, FolderTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { FILE_EXPLORER_FULL_ROOT, type ExplorerRootOption } from './file-explorer-display-root'

export type FileExplorerRootSelectProps = {
  options: ExplorerRootOption[]
  value: string
  onValueChange: (value: string) => void
  disabled: boolean
}

export function FileExplorerRootSelect({
  options,
  value,
  onValueChange,
  disabled
}: FileExplorerRootSelectProps): React.JSX.Element {
  const fullRootLabel = translate('fileExplorer.root.full', 'Repository root')
  const atRoot = value === FILE_EXPLORER_FULL_ROOT
  const selectedLabel = atRoot
    ? fullRootLabel
    : (options.find((option) => option.value === value)?.label ?? value)
  return (
    <nav
      aria-label={translate('fileExplorer.root.label', 'Explorer root')}
      className="flex min-w-0 flex-1 items-center"
    >
      {!atRoot && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={fullRootLabel}
                onClick={() => onValueChange(FILE_EXPLORER_FULL_ROOT)}
              >
                <FolderTree />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullRootLabel}</TooltipContent>
          </Tooltip>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="min-w-0"
                disabled={disabled}
                aria-label={translate('fileExplorer.root.label', 'Explorer root')}
              >
                {atRoot && <FolderTree />}
                <span className="truncate">{selectedLabel}</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm [overflow-wrap:anywhere]">
            {selectedLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          collisionPadding={8}
          className="w-72 max-w-[calc(100vw-1rem)]"
        >
          <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                  {option.value === FILE_EXPLORER_FULL_ROOT ? fullRootLabel : option.label}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}
