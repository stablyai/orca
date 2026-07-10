import { Check, ChevronsUpDown } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { Repo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Command, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import RepoBadgeLabel from '../repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export const GLOBAL_SCOPE_KEY = '__global__'

export function getQuickCommandRepoLabel(repo: Pick<Repo, 'displayName' | 'path'>): string {
  return repo.displayName || repo.path
}

function ScopeTriggerLabel({
  showAll,
  effectiveSelection,
  repos
}: {
  showAll: boolean
  effectiveSelection: ReadonlySet<string>
  repos: Repo[]
}): React.JSX.Element {
  if (showAll) {
    return (
      <span>
        {translate('auto.components.settings.QuickCommandsPane.c6b155911b', 'All commands')}
      </span>
    )
  }
  const includesGlobal = effectiveSelection.has(GLOBAL_SCOPE_KEY)
  const selectedRepos = repos.filter((repo) => effectiveSelection.has(repo.id))
  const parts: string[] = []
  if (includesGlobal) {
    parts.push('Global')
  }
  if (selectedRepos.length > 0) {
    const [first, ...rest] = selectedRepos
    parts.push(rest.length > 0 ? `${first.displayName} +${rest.length}` : first.displayName)
  }
  return (
    <span className="truncate">
      {parts.join(', ') ||
        translate('auto.components.settings.QuickCommandsPane.d1d0976320', 'None')}
    </span>
  )
}

export function QuickCommandsScopeFilter({
  repos,
  effectiveSelection,
  showAll,
  scopePopoverOpen,
  setScopePopoverOpen,
  handleSelectAll,
  toggleScope
}: {
  repos: Repo[]
  effectiveSelection: ReadonlySet<string>
  showAll: boolean
  scopePopoverOpen: boolean
  setScopePopoverOpen: Dispatch<SetStateAction<boolean>>
  handleSelectAll: () => void
  toggleScope: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={scopePopoverOpen} onOpenChange={setScopePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={scopePopoverOpen}
            className="h-8 min-w-52 justify-between px-3 text-xs font-normal"
          >
            <ScopeTriggerLabel
              showAll={showAll}
              effectiveSelection={effectiveSelection}
              repos={repos}
            />
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command>
            <div className="border-b border-border">
              <button
                type="button"
                onClick={handleSelectAll}
                onMouseDown={(event) => event.preventDefault()}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                  showAll && 'opacity-80'
                )}
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    showAll ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span>
                  {translate(
                    'auto.components.settings.QuickCommandsPane.c6b155911b',
                    'All commands'
                  )}
                </span>
              </button>
            </div>
            <CommandList>
              <CommandItem
                value={GLOBAL_SCOPE_KEY}
                onSelect={() => toggleScope(GLOBAL_SCOPE_KEY)}
                className="items-center gap-2 px-3 py-1.5 text-xs"
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    effectiveSelection.has(GLOBAL_SCOPE_KEY) ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span>
                  {translate('auto.components.settings.QuickCommandsPane.8c877dec41', 'Global')}
                </span>
              </CommandItem>
              {repos.map((repo) => {
                const isSelected = effectiveSelection.has(repo.id)
                return (
                  <CommandItem
                    key={repo.id}
                    value={repo.id}
                    onSelect={() => toggleScope(repo.id)}
                    className="items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        isSelected ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <RepoBadgeLabel
                      name={getQuickCommandRepoLabel(repo)}
                      color={repo.badgeColor}
                      className="max-w-full"
                    />
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
