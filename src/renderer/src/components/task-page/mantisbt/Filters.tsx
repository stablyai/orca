import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import {
  buildMantisBTProjectSelectionKey,
  flattenMantisBTProjectTree
} from '../../task-page-mantisbt-project-selection'
import { translate } from '@/i18n/i18n'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'

export function TaskPageMantisBTFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    mantisBTPresets,
    mantisBTLoading,
    mantisBTSearchInput,
    setMantisBTSearchInput,
    activeMantisBTPreset,
    setActiveMantisBTPreset,
    setMantisBTRefreshNonce,
    mantisBTProjects,
    selectedMantisBTProjectId,
    setSelectedMantisBTProjectId
  } = model
  const flattenedProjects = flattenMantisBTProjectTree(mantisBTProjects)
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {mantisBTPresets.map((preset) => {
            const active = !mantisBTSearchInput && activeMantisBTPreset === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setMantisBTSearchInput('')
                  setActiveMantisBTPreset(preset.id)
                  setMantisBTRefreshNonce((n) => n + 1)
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setMantisBTRefreshNonce((n) => n + 1)}
                disabled={mantisBTLoading}
                aria-label={translate(
                  'auto.components.TaskPage.mantisbtRefreshIssues',
                  'Refresh MantisBT issues'
                )}
                className="inline-flex size-9 items-center justify-center rounded-md border border-border/50 bg-transparent text-foreground transition hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                {mantisBTLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.TaskPage.mantisbtRefreshIssues',
                'Refresh MantisBT issues'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={mantisBTSearchInput}
            onChange={(e) => setMantisBTSearchInput(e.target.value)}
            placeholder={translate(
              'auto.components.TaskPage.mantisbtSearchPlaceholder',
              'Filter by title or description'
            )}
            className="h-8 w-full min-w-0 rounded-md border border-border/50 bg-background pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {mantisBTSearchInput ? (
            <button
              type="button"
              aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
              onClick={() => setMantisBTSearchInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        {flattenedProjects.length > 1 ? (
          <Select
            value={selectedMantisBTProjectId}
            onValueChange={(value) => {
              setSelectedMantisBTProjectId(value)
              setMantisBTRefreshNonce((n) => n + 1)
            }}
          >
            <SelectTrigger className="h-8 w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {translate('auto.components.TaskPage.mantisbtAllProjects', 'All projects')}
              </SelectItem>
              {flattenedProjects.map(({ project, depth }) => (
                <SelectItem
                  key={buildMantisBTProjectSelectionKey(project.siteId, project.id)}
                  value={buildMantisBTProjectSelectionKey(project.siteId, project.id)}
                >
                  <span style={{ paddingLeft: depth * 12 }}>{project.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  )
}
