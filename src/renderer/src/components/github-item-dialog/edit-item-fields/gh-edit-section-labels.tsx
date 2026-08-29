import React from 'react'
import { ChevronDown, LoaderCircle, Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { GitHubLabelsSettingsLink } from './github-labels-settings-link'

const checkIcon = (
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

export function GHEditSectionLabelsColumn({
  localLabels,
  repoLabels,
  repositoryLabelsUrl,
  isPending,
  popoverOpen,
  onPopoverOpenChange,
  onToggle
}: {
  localLabels: string[]
  repoLabels: { data: string[]; loading: boolean; error: string | null }
  repositoryLabelsUrl: string | null
  isPending: boolean
  popoverOpen: boolean
  onPopoverOpenChange: (open: boolean) => void
  onToggle: (label: string) => void
}): React.JSX.Element {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <span>{translate('auto.components.GitHubItemDialog.217e55d87c', 'Labels')}</span>
        <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={isPending || repoLabels.loading}
              aria-label={translate('auto.components.GitHubItemDialog.4ba0132f37', 'Edit labels')}
              className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {isPending ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Pencil className="size-3" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="popover-scroll-content scrollbar-sleek w-60 p-1" align="end">
            {repoLabels.error ? (
              <div className="px-2 py-3 text-center text-[12px] text-destructive">
                {repoLabels.error}
              </div>
            ) : null}
            {!repoLabels.error ? (
              <div>
                {repoLabels.data.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onToggle(label)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                  >
                    <span
                      className={cn(
                        'flex size-3.5 items-center justify-center rounded-sm border',
                        localLabels.includes(label)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input'
                      )}
                    >
                      {localLabels.includes(label) && checkIcon}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <GitHubLabelsSettingsLink
              url={repositoryLabelsUrl}
              separated={!repoLabels.error && repoLabels.data.length > 0}
              onOpen={() => onPopoverOpenChange(false)}
            />
          </PopoverContent>
        </Popover>
      </div>
      {localLabels.length === 0 ? (
        <div className="text-[12px] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.886a64b081', 'None yet')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {localLabels.map((name) => (
            <span
              key={name}
              className="inline-flex items-center rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground"
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export function GHEditSectionLabelsPill({
  localLabels,
  repoLabels,
  repositoryLabelsUrl,
  isPending,
  popoverOpen,
  onPopoverOpenChange,
  onToggle
}: {
  localLabels: string[]
  repoLabels: { data: string[]; loading: boolean; error: string | null }
  repositoryLabelsUrl: string | null
  isPending: boolean
  popoverOpen: boolean
  onPopoverOpenChange: (open: boolean) => void
  onToggle: (label: string) => void
}): React.JSX.Element {
  return (
    <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isPending || repoLabels.loading}
          className="group/labels inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
        >
          {localLabels.length === 0 ? (
            <span className="text-muted-foreground">
              {translate('auto.components.GitHubItemDialog.f41ec96c13', '+ Label')}
            </span>
          ) : (
            localLabels.map((name) => (
              <span key={name} className="text-[10px] text-muted-foreground">
                {name}
              </span>
            ))
          )}
          {isPending ? (
            <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-2.5 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
        {repoLabels.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">
            {repoLabels.error}
          </div>
        ) : null}
        {!repoLabels.error ? (
          <div>
            {repoLabels.data.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => onToggle(label)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex size-3.5 items-center justify-center rounded-sm border',
                    localLabels.includes(label)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {localLabels.includes(label) && checkIcon}
                </span>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <GitHubLabelsSettingsLink
          url={repositoryLabelsUrl}
          separated={!repoLabels.error && repoLabels.data.length > 0}
          onOpen={() => onPopoverOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
