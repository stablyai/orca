import { useState } from 'react'
import { Check, Star } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty
} from '@/components/ui/command'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

export function TaskPageJiraFavouriteFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const {
    jiraFavouriteFiltersEnabled: enabled,
    jiraFavouriteFilters: filters,
    jiraFavouriteFilter: active,
    jiraFavouriteFiltersLoading: loading,
    jiraFavouriteFiltersPending: pending,
    jiraFavouriteFiltersUnsupported: unsupported,
    jiraFavouriteFiltersTruncated: truncated,
    jiraFavouriteFiltersError: error,
    retryJiraFavouriteFilters: retry,
    loadJiraFavouriteFilters: load,
    applyJiraFavouriteFilter: apply,
    clearJiraFavouriteFilter: clear,
    jiraSavedFiltersLoading,
    jiraSavedFiltersPending,
    jiraSavedFiltersReady
  } = model
  const disabled =
    loading ||
    pending ||
    jiraSavedFiltersLoading ||
    jiraSavedFiltersPending ||
    !jiraSavedFiltersReady
  const names = new Map<string, number>()
  for (const filter of filters ?? []) {
    names.set(filter.name, (names.get(filter.name) ?? 0) + 1)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          load()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-64"
          title={active?.name}
          aria-label={
            active
              ? translate('jira.favourites.activeLabel', 'Jira favourites: {{name}}', {
                  name: active.name
                })
              : translate('jira.favourites.label', 'Jira favourites')
          }
        >
          <Star />
          <span className="truncate">
            {active ? active.name : translate('jira.favourites.label', 'Jira favourites')}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={translate('jira.favourites.label', 'Jira favourites')}
        align="start"
        sideOffset={6}
        className="w-72"
      >
        {!enabled ? (
          <p className="p-3 text-xs text-muted-foreground">
            {translate(
              'jira.favourites.chooseSite',
              'Choose one connected Jira site to use its favourites.'
            )}
          </p>
        ) : unsupported ? (
          <div className="space-y-2 p-3">
            <p className="text-xs text-muted-foreground">
              {translate('jira.favourites.unsupported', 'Update the Jira host to use favourites.')}
            </p>
            <Button variant="outline" size="xs" onClick={retry}>
              {translate('jira.favourites.refresh', 'Refresh')}
            </Button>
            {active ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clear()
                  setOpen(false)
                }}
              >
                {translate('jira.favourites.clear', 'Clear Jira favourite')}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
              <p className="text-xs font-medium">
                {translate('jira.favourites.label', 'Jira favourites')}
              </p>
              <Button variant="ghost" size="xs" disabled={loading || pending} onClick={retry}>
                {translate('jira.favourites.refresh', 'Refresh')}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {loading ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {translate('jira.favourites.loading', 'Loading favourites…')}
              </p>
            ) : (
              <Command label={translate('jira.favourites.label', 'Jira favourites')}>
                <CommandInput
                  placeholder={translate('jira.favourites.find', 'Find a Jira favourite')}
                />
                <CommandList
                  label={translate('jira.favourites.label', 'Jira favourites')}
                  className="max-h-72"
                >
                  {!error ? (
                    <CommandEmpty>
                      {translate('jira.favourites.empty', 'No Jira favourites found.')}
                    </CommandEmpty>
                  ) : null}
                  {filters.map((filter) => (
                    <CommandItem
                      key={filter.id}
                      value={filter.id}
                      keywords={[filter.name]}
                      aria-current={active?.id === filter.id ? 'true' : undefined}
                      disabled={disabled}
                      onSelect={() => {
                        void apply(filter).then((applied) => {
                          if (applied) {
                            setOpen(false)
                          }
                        })
                      }}
                    >
                      <Check
                        aria-hidden
                        className={
                          active?.id === filter.id
                            ? 'size-3.5 shrink-0'
                            : 'size-3.5 shrink-0 opacity-0'
                        }
                      />
                      <span className="truncate">{filter.name}</span>
                      {(names.get(filter.name) ?? 0) > 1 ? (
                        <span className="text-xs text-muted-foreground">#{filter.id}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            )}
            {truncated ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {translate(
                  'jira.favourites.truncated',
                  'Some favourites could not be listed. Manage your favourites in Jira to narrow the list.'
                )}
              </p>
            ) : null}
            {active ? (
              <div className="border-t border-border/50 p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    clear()
                    setOpen(false)
                  }}
                >
                  {translate('jira.favourites.clear', 'Clear Jira favourite')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
