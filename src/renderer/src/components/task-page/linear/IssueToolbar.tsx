import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ChevronLeft, SlidersHorizontal, List, ArrowDownUp, Eye } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem
} from '@/components/ui/dropdown-menu'
import type {
  LinearViewMode,
  LinearGroupBy,
  LinearOrderBy
} from '@/components/task-page-localized-options'
export function TaskPageLinearIssueToolbar({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    setTaskResumeState,
    linearViewOptions,
    linearGroupOptions,
    linearOrderOptions,
    linearDisplayPropertyOptions,
    linearMode,
    linearViewMode,
    setLinearViewMode,
    linearGroupBy,
    setLinearGroupBy,
    linearOrderBy,
    setLinearOrderBy,
    selectedLinearProject,
    setLinearProjectTab,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    activeLinearIssueContextLabel,
    pagedLinearIssues,
    effectiveLinearDisplayProperties,
    toggleLinearDisplayProperty
  } = model
  return (
    <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
      <div className="flex min-w-0 items-center gap-2">
        {activeLinearIssueContextLabel ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              if (selectedLinearProject) {
                setLinearProjectTab('overview')
                return
              }
              setSelectedLinearCustomView(null)
              setLinearProjectParentView(null)
              setTaskResumeState({
                linearContext: undefined
              })
            }}
            aria-label={translate('auto.components.TaskPage.f397d513e3', 'Back')}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
        ) : null}
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {activeLinearIssueContextLabel ??
            (linearMode === 'in-orca'
              ? translate('auto.components.TaskPage.linearModeHasWorktree', 'Has Workspace')
              : translate('auto.components.TaskPage.60f68a2ef4', 'Linear issues'))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div
          className="hidden items-center rounded-md border border-border/50 bg-background/70 p-0.5 md:flex"
          aria-label={translate('auto.components.TaskPage.d47248df4d', 'Linear view mode')}
        >
          {linearViewOptions.map(({ id, label, Icon }) => {
            const active = linearViewMode === id
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setLinearViewMode(id)}
                    aria-label={translate(
                      'auto.components.TaskPage.af377b13b1',
                      '{{value0}} view',
                      {
                        value0: label
                      }
                    )}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex size-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground',
                      active && 'bg-accent text-accent-foreground shadow-xs'
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.TaskPage.af377b13b1', '{{value0}} view', {
                    value0: label
                  })}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="gap-1 border-border/50 bg-background/70 text-[11px]"
            >
              <SlidersHorizontal className="size-3.5" />
              {translate('auto.components.TaskPage.9c57663908', 'View')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex items-center gap-2">
              <List className="size-3.5" />
              {translate('auto.components.TaskPage.9c57663908', 'View')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={linearViewMode}
              onValueChange={(value) => setLinearViewMode(value as LinearViewMode)}
            >
              {linearViewOptions.map(({ id, label, Icon }) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  <Icon className="size-3.5" />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <SlidersHorizontal className="size-3.5" />
              {translate('auto.components.TaskPage.5659da12fc', 'Grouping')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={linearGroupBy}
              onValueChange={(value) => setLinearGroupBy(value as LinearGroupBy)}
            >
              {linearGroupOptions.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <ArrowDownUp className="size-3.5" />
              {translate('auto.components.TaskPage.5d2d835467', 'Ordering')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={linearOrderBy}
              onValueChange={(value) => setLinearOrderBy(value as LinearOrderBy)}
            >
              {linearOrderOptions.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <Eye className="size-3.5" />
              {translate('auto.components.TaskPage.a26a48252e', 'Display properties')}
            </DropdownMenuLabel>
            {linearDisplayPropertyOptions.map((property) => (
              <DropdownMenuCheckboxItem
                key={property.id}
                checked={effectiveLinearDisplayProperties.has(property.id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleLinearDisplayProperty(property.id)}
              >
                {property.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="text-[11px] text-muted-foreground">
          {pagedLinearIssues.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
        </div>
      </div>
    </div>
  )
}
