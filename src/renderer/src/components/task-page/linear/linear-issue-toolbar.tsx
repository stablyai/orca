import React from 'react'
import { ArrowDownUp, ChevronLeft, Eye, List, SlidersHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearMode,
  LinearOrderBy,
  LinearViewMode
} from '@/components/task-page-localized-options'
import type { LinearProjectTab } from './linear-issue-grouping'

export type LinearIssueToolbarProps = {
  activeLinearIssueContextLabel: string | null
  selectedLinearProject: LinearProjectSummary | null
  setLinearProjectTab: (tab: LinearProjectTab) => void
  setSelectedLinearCustomView: (view: LinearCustomViewSummary | null) => void
  setLinearProjectParentView: (view: LinearCustomViewSummary | null) => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  linearMode: LinearMode
  linearViewOptions: {
    id: LinearViewMode
    label: string
    Icon: React.ComponentType<{ className?: string }>
  }[]
  linearViewMode: LinearViewMode
  setLinearViewMode: (mode: LinearViewMode) => void
  linearGroupBy: LinearGroupBy
  setLinearGroupBy: (group: LinearGroupBy) => void
  linearGroupOptions: { id: LinearGroupBy; label: string }[]
  linearOrderBy: LinearOrderBy
  setLinearOrderBy: (order: LinearOrderBy) => void
  linearOrderOptions: { id: LinearOrderBy; label: string }[]
  linearDisplayPropertyOptions: { id: LinearDisplayProperty; label: string }[]
  effectiveLinearDisplayProperties: ReadonlySet<LinearDisplayProperty>
  toggleLinearDisplayProperty: (property: LinearDisplayProperty) => void
  pagedLinearIssuesCount: number
  linearIssueGridStyle: React.CSSProperties
}

export function LinearIssueToolbar({
  activeLinearIssueContextLabel,
  selectedLinearProject,
  setLinearProjectTab,
  setSelectedLinearCustomView,
  setLinearProjectParentView,
  setTaskResumeState,
  linearMode,
  linearViewOptions,
  linearViewMode,
  setLinearViewMode,
  linearGroupBy,
  setLinearGroupBy,
  linearGroupOptions,
  linearOrderBy,
  setLinearOrderBy,
  linearOrderOptions,
  linearDisplayPropertyOptions,
  effectiveLinearDisplayProperties,
  toggleLinearDisplayProperty,
  pagedLinearIssuesCount,
  linearIssueGridStyle
}: LinearIssueToolbarProps): React.JSX.Element {
  return (
    <>
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
                setTaskResumeState({ linearContext: undefined })
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
            role="group"
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
                        { value0: label }
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
            {pagedLinearIssuesCount} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
          </div>
        </div>
      </div>

      {linearViewMode === 'list' && linearGroupBy === 'none' ? (
        <div
          className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-lg:!hidden lg:grid-cols-[var(--linear-grid-template)] [&>span]:min-w-0 [&>span]:truncate"
          style={linearIssueGridStyle}
        >
          <span>{translate('auto.components.TaskPage.37e7ee311e', 'Key')}</span>
          <span>{translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}</span>
          {effectiveLinearDisplayProperties.has('labels') ? (
            <span>{translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('team') ? (
            <span>{translate('auto.components.TaskPage.a98cbe7664', 'Team')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('state') ? (
            <span>{translate('auto.components.TaskPage.154b0fa623', 'Status')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('assignee') ? (
            <span className="text-center">
              {translate('auto.components.TaskPage.d2a876ca53', 'Assignee')}
            </span>
          ) : null}
          {effectiveLinearDisplayProperties.has('updated') ? (
            <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
          ) : null}
          <span>{translate('auto.components.TaskPage.linearWorktreesColumn', 'Workspaces')}</span>
        </div>
      ) : null}
    </>
  )
}
