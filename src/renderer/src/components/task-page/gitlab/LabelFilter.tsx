import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type GitLabLabelFilterProps = {
  labels: readonly string[]
  loadFailed?: boolean
  selected: readonly string[]
  onChange: (labels: string[]) => void
}

export function TaskPageGitLabLabelFilter({
  labels,
  loadFailed = false,
  selected,
  onChange
}: GitLabLabelFilterProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = labels.filter((label) =>
    label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  const allLabels = translate('auto.components.TaskPage.gitlabAllLabels', 'All labels')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={translate('auto.components.TaskPage.gitlabLabel', 'Labels')}
          aria-expanded={open}
          className="h-8 w-[170px] justify-between"
        >
          <span className="truncate">
            {selected.length === 0
              ? allLabels
              : selected.length === 1
                ? selected[0]
                : translate(
                    'auto.components.TaskPage.gitlabSelectedLabelCount',
                    '{{count}} labels',
                    { count: selected.length }
                  )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(280px,calc(100vw-1rem))]">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.TaskPage.gitlabSearchLabels',
              'Search labels...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <div className="border-b border-border">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange([])}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Check className={cn('size-3', selected.length > 0 && 'opacity-0')} />
              {allLabels}
            </button>
          </div>
          <CommandList>
            {loadFailed && labels.length > 0 ? (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPage.gitlabLabelsPartial',
                  'Some labels could not load. Try Refresh.'
                )}
              </p>
            ) : null}
            <CommandEmpty>
              {loadFailed
                ? translate(
                    'auto.components.TaskPage.gitlabLabelsFailed',
                    'Could not load labels. Try Refresh.'
                  )
                : labels.length === 0
                  ? translate('auto.components.TaskPage.gitlabNoLabels', 'No labels available.')
                  : translate(
                      'auto.components.TaskPage.gitlabNoLabelMatches',
                      'No matching labels.'
                    )}
            </CommandEmpty>
            {filtered.map((label) => (
              <CommandItem
                key={label}
                value={label}
                disabled={label.includes(',')}
                onSelect={() =>
                  onChange(
                    selected.includes(label)
                      ? selected.filter((item) => item !== label)
                      : [...selected, label]
                  )
                }
              >
                <Check className={cn('size-3', !selected.includes(label) && 'opacity-0')} />
                <span className="truncate">{label}</span>
                {label.includes(',') ? (
                  <span className="text-xs text-muted-foreground">
                    {translate('auto.components.TaskPage.gitlabLabelUnsupported', 'Unsupported')}
                  </span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
