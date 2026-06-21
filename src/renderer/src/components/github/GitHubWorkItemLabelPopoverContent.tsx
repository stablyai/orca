import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Settings } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { filterGitHubWorkItemLabels } from './github-work-item-label-filter'

const labelCheckIcon = (
  <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 6l3 3 5-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

function GitHubLabelsSettingsLink({
  url,
  separated,
  onOpen
}: {
  url: string | null
  separated?: boolean
  onOpen?: () => void
}): React.JSX.Element | null {
  if (!url) {
    return null
  }

  return (
    <div className={cn(separated && 'mt-1 border-t border-border/60 pt-1')}>
      <button
        type="button"
        onClick={() => {
          onOpen?.()
          void window.api.shell.openUrl(url)
        }}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Settings className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-left">
          {translate(
            'auto.components.github.GitHubWorkItemLabelPopoverContent.2aa9acdf34',
            'Edit labels on GitHub'
          )}
        </span>
        <ExternalLink className="size-3 shrink-0 opacity-70" />
      </button>
    </div>
  )
}

export function GitHubWorkItemLabelPopoverContent({
  open,
  labels,
  selectedLabels,
  error,
  loading,
  repositoryLabelsUrl,
  onToggleLabel,
  onOpenSettingsLink
}: {
  open: boolean
  labels: readonly string[]
  selectedLabels: readonly string[]
  error: string | null | undefined
  loading?: boolean
  repositoryLabelsUrl?: string | null
  onToggleLabel: (label: string) => void
  onOpenSettingsLink?: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filteredLabels = useMemo(() => filterGitHubWorkItemLabels(labels, query), [labels, query])
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels])

  useEffect(() => {
    if (!open) {
      setQuery('')
    }
  }, [open])

  if (error) {
    return <div className="px-2 py-3 text-center text-[12px] text-destructive">{error}</div>
  }

  const emptyText = loading
    ? translate(
        'auto.components.github.GitHubWorkItemLabelPopoverContent.cddd9b04a7',
        'Loading labels'
      )
    : translate('auto.components.github.GitHubWorkItemLabelPopoverContent.de26e2eb06', 'No labels')

  return (
    <>
      <Command shouldFilter={false} className="bg-transparent">
        <CommandInput
          placeholder={translate(
            'auto.components.github.GitHubWorkItemLabelPopoverContent.8b0d52ee3a',
            'Filter labels...'
          )}
          value={query}
          onValueChange={setQuery}
          className="h-8 text-[12px]"
          wrapperClassName="border-b border-border/60 px-2"
          iconClassName="size-3.5"
        />
        <CommandList className="max-h-60">
          <CommandEmpty className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            {emptyText}
          </CommandEmpty>
          {filteredLabels.map((label) => {
            const isSelected = selectedSet.has(label)
            return (
              <CommandItem
                key={label}
                value={label}
                onSelect={() => onToggleLabel(label)}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[12px]"
              >
                <span
                  className={cn(
                    'flex size-3.5 items-center justify-center rounded-sm border',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {isSelected ? labelCheckIcon : null}
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>
      <GitHubLabelsSettingsLink
        url={repositoryLabelsUrl ?? null}
        separated={labels.length > 0}
        onOpen={onOpenSettingsLink}
      />
    </>
  )
}
