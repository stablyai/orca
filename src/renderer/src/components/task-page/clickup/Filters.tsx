import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { isClickUpStatusClosed } from '../../../../../shared/clickup/clickup-task-filter'
import type { ClickUpTaskScope } from '../../../../../shared/clickup/clickup-types'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { safeClickUpColor } from '../../../../../shared/clickup/clickup-color'

const CHIP_CLASS = 'rounded-md border px-2 py-1 text-xs transition'
const CHIP_ACTIVE = 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
const CHIP_IDLE = 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'

export function TaskPageClickUpFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const {
    clickupFilter,
    setClickUpFilter,
    clickupKnownStatuses,
    clickupLoading,
    clickupSearchInput,
    setClickUpSearchInput,
    appliedClickUpSearch,
    applyClickUpSearch,
    refreshClickUpTasks
  } = model
  const scopes: { id: ClickUpTaskScope; label: string }[] = [
    { id: 'assigned', label: t('taskProviders.clickup.scopeAssigned', 'Assigned to me') },
    { id: 'all', label: t('taskProviders.clickup.scopeAll', 'All') }
  ]
  const selectedStatuses = clickupFilter.statuses ?? []
  const closedStatusNames = new Set(
    clickupKnownStatuses.filter(isClickUpStatusClosed).map((status) => status.name)
  )
  const offeredStatuses = clickupFilter.includeClosed
    ? clickupKnownStatuses
    : clickupKnownStatuses.filter((status) => !closedStatusNames.has(status.name))
  // Why: a selected status stays toggleable even when the current results no longer include it.
  const statusChips = [
    ...offeredStatuses,
    ...selectedStatuses
      .filter((name) => !offeredStatuses.some((status) => status.name === name))
      .map((name) => ({ name, color: '' }))
  ]
  const withStatuses = (
    current: typeof clickupFilter,
    statuses: string[]
  ): typeof clickupFilter => ({
    scope: current.scope,
    includeClosed: current.includeClosed,
    ...(statuses.length > 0 ? { statuses } : {})
  })
  // Why: an open-only list cannot hold a done status, so keeping it selected would show nothing.
  const toggleIncludeClosed = (): void =>
    setClickUpFilter((current) => {
      const includeClosed = !current.includeClosed
      const statuses = (current.statuses ?? []).filter(
        (name) => includeClosed || !closedStatusNames.has(name)
      )
      return { ...withStatuses(current, statuses), includeClosed }
    })
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {scopes.map((scope) => (
            <button
              key={scope.id}
              type="button"
              aria-pressed={clickupFilter.scope === scope.id}
              onClick={() => setClickUpFilter((current) => ({ ...current, scope: scope.id }))}
              className={cn(CHIP_CLASS, clickupFilter.scope === scope.id ? CHIP_ACTIVE : CHIP_IDLE)}
            >
              {scope.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={clickupFilter.includeClosed}
            onClick={toggleIncludeClosed}
            className={cn(CHIP_CLASS, clickupFilter.includeClosed ? CHIP_ACTIVE : CHIP_IDLE)}
          >
            {t('taskProviders.clickup.includeClosed', 'Include closed')}
          </button>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshClickUpTasks}
              disabled={clickupLoading}
              aria-label={t('taskProviders.clickup.refresh', 'Refresh ClickUp tasks')}
            >
              {clickupLoading ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('taskProviders.clickup.refresh', 'Refresh ClickUp tasks')}
          </TooltipContent>
        </Tooltip>
      </div>
      {statusChips.length > 0 ? (
        <ToggleGroup
          type="multiple"
          variant="segmented"
          size="xs"
          spacing={1}
          value={selectedStatuses}
          aria-label={t('taskProviders.clickup.statusFilter', 'Filter by status')}
          onValueChange={(next) => setClickUpFilter((current) => withStatuses(current, next))}
          className="mt-3 flex-wrap"
        >
          {statusChips.map((status) => {
            const color = safeClickUpColor(status.color)
            return (
              <ToggleGroupItem key={status.name} value={status.name} className="max-w-[200px]">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full bg-muted-foreground/60"
                  style={color ? { backgroundColor: color } : undefined}
                />
                <span className="truncate">{status.name}</span>
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={clickupSearchInput}
            onChange={(event) => setClickUpSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !shouldSuppressEnterSubmit(
                  { isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey },
                  false
                )
              ) {
                event.preventDefault()
                applyClickUpSearch(clickupSearchInput)
              }
            }}
            placeholder={t(
              'taskProviders.clickup.searchPlaceholder',
              'Search tasks by name or ID, or paste a ClickUp task link'
            )}
            surface="background"
            density="compact"
            inset="leadingIcon"
            adornment="trailing"
            className="h-8"
          />
          {clickupSearchInput || appliedClickUpSearch ? (
            <button
              type="button"
              aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
              onClick={() => applyClickUpSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
