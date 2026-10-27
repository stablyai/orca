import { ExternalLink, LoaderCircle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export function QuickTasksToggle<Value extends string>({
  value,
  options,
  onChange
}: {
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      size="xs"
      variant="outline"
      spacing={0}
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next)
        if (option) {
          onChange(option.value)
        }
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

type QuickTaskRowProps = {
  icon: React.ReactNode
  /** Provider-style reference, e.g. `#12` for issues or `!7` for GitLab merge requests. */
  reference: string
  title: string
  repoName: string | null
  onOpen: () => void
  onCreateWorkspace: () => void
  onOpenExternal: () => void
}

export function QuickTaskRow({
  icon,
  reference,
  title,
  repoName,
  onOpen,
  onCreateWorkspace,
  onOpenExternal
}: QuickTaskRowProps): React.JSX.Element {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-accent/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
        onClick={onOpen}
      >
        <span className="mt-0.5 flex-none text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm text-foreground">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {reference}
            {repoName ? ` · ${repoName}` : ''}
          </span>
        </span>
      </button>
      <div className="flex flex-none items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.rightSidebar.QuickTasksPanel.createWorkspace',
                'Create workspace'
              )}
              onClick={onCreateWorkspace}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.createWorkspace',
              'Create workspace'
            )}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.rightSidebar.QuickTasksPanel.openInBrowser',
                'Open in browser'
              )}
              onClick={onOpenExternal}
            >
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.openInBrowser',
              'Open in browser'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function QuickTasksSection({
  icon,
  label,
  loading,
  failed,
  count,
  emptyLabel,
  toggle,
  children
}: {
  icon: React.ReactNode
  label: string
  loading: boolean
  failed: boolean
  count: number
  emptyLabel: string
  toggle: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="py-1">
      <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {loading && count > 0 ? <LoaderCircle className="size-3 animate-spin" /> : null}
        {toggle}
      </div>
      {loading && count === 0 ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" />
          {translate('auto.components.rightSidebar.QuickTasksPanel.loading', 'Loading…')}
        </div>
      ) : failed ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.rightSidebar.QuickTasksPanel.loadFailed',
            'Could not load tasks.'
          )}
        </div>
      ) : !loading && count === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        children
      )}
    </section>
  )
}
