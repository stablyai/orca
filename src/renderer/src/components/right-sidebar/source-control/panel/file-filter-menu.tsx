import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SourceControlFileGroup } from '../../../../../../shared/source-control-file-groups'
import type { SourceControlExtensionCount } from '../listing/file-visibility'

/** Extensions select visible files; group toggles hide matching files without changing Git actions. */
export function SourceControlFileFilterMenu({
  extensionCounts,
  excludedExtensions,
  onExcludedExtensionsChange,
  fileGroups,
  hiddenFileGroups,
  onHiddenFileGroupsChange,
  isFiltering,
  fileGroupsFailed,
  onOpen,
  onReset
}: {
  extensionCounts: readonly SourceControlExtensionCount[]
  excludedExtensions: ReadonlySet<string>
  onExcludedExtensionsChange: (value: ReadonlySet<string>) => void
  fileGroups: readonly SourceControlFileGroup[]
  hiddenFileGroups: ReadonlySet<string>
  onHiddenFileGroupsChange: (value: ReadonlySet<string>) => void
  isFiltering: boolean
  fileGroupsFailed: boolean
  onOpen: () => void
  onReset: () => void
}) {
  const shownExtensions = extensionCounts.filter(
    ({ extension }) => !excludedExtensions.has(extension)
  ).length
  const hiddenGroupCount = fileGroups.filter((group) => hiddenFileGroups.has(group.name)).length
  const title = translate('sourceControl.fileFilters.title', 'Filter files by extension or group')

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={isFiltering ? 'secondary' : 'ghost'}
              size="icon-xs"
              aria-label={title}
            >
              <ListFilter />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {translate('sourceControl.fileFilters.extensions', 'Show extensions')}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={shownExtensions === extensionCounts.length}
          disabled={extensionCounts.length === 0}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) =>
            onExcludedExtensionsChange(
              new Set(checked ? [] : extensionCounts.map(({ extension }) => extension))
            )
          }
        >
          {translate('sourceControl.fileFilters.allExtensions', 'All extensions')}
        </DropdownMenuCheckboxItem>
        {extensionCounts.map(({ extension, count }) => (
          <DropdownMenuCheckboxItem
            key={extension}
            checked={!excludedExtensions.has(extension)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onExcludedExtensionsChange(
                new Set(
                  checked
                    ? [...excludedExtensions].filter((value) => value !== extension)
                    : [...excludedExtensions, extension]
                )
              )
            }
          >
            <span className="min-w-0 flex-1 truncate">
              {extension || translate('sourceControl.fileFilters.noExtension', 'No extension')}
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {fileGroups.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {translate('sourceControl.fileFilters.groups', 'Hide file groups')}
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={hiddenGroupCount === fileGroups.length}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onHiddenFileGroupsChange(
                  new Set(checked ? fileGroups.map((group) => group.name) : [])
                )
              }
            >
              {translate('sourceControl.fileFilters.allGroups', 'All groups')}
            </DropdownMenuCheckboxItem>
            {fileGroups.map((group) => (
              <DropdownMenuCheckboxItem
                key={group.name}
                checked={hiddenFileGroups.has(group.name)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onHiddenFileGroupsChange(
                    new Set(
                      checked
                        ? [...hiddenFileGroups, group.name]
                        : [...hiddenFileGroups].filter((name) => name !== group.name)
                    )
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
        {fileGroupsFailed && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {translate('sourceControl.fileFilters.loadError', 'Could not load file groups.')}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!isFiltering} onSelect={onReset}>
          {translate('sourceControl.fileFilters.reset', 'Reset filters')}
        </DropdownMenuItem>
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {translate('sourceControl.fileFilters.scope', 'Filters change this list only.')}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
