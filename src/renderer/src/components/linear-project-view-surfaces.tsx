/* eslint-disable max-lines -- Why: project/view tables and project overview
   share compact Linear metadata presentation rules for the Tasks Linear surface. */
import React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ExternalLink,
  FileText,
  FolderKanban,
  Layers3,
  RefreshCw,
  UserRound
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearWorkspaceError
} from '../../../shared/types'

type LinearProjectLike = LinearProjectSummary & {
  content?: string
  summary?: string
  description?: string
  status?: unknown
  health?: unknown
  lead?: unknown
  members?: unknown[]
  teams?: unknown[]
  labels?: unknown[]
  milestones?: unknown[]
  resources?: unknown[]
  latestUpdate?: unknown
  lastUpdate?: unknown
}

type LinearProjectTableProps = {
  projects: LinearProjectSummary[]
  loading: boolean
  hasError?: boolean
  selectedProjectId?: string | null
  workspaceSelection?: string | null
  onSelectProject: (project: LinearProjectSummary) => void
  onOpenProject: (project: LinearProjectSummary) => void
  onUseProjectIssues?: (project: LinearProjectSummary) => void
}

type LinearCustomViewTableProps = {
  views: LinearCustomViewSummary[]
  model: LinearCustomViewModel
  loading: boolean
  hasError?: boolean
  selectedViewId?: string | null
  workspaceSelection?: string | null
  onSelectView: (view: LinearCustomViewSummary) => void
  onOpenView: (view: LinearCustomViewSummary) => void
}

type LinearProjectOverviewProps = {
  project: LinearProjectDetail | LinearProjectSummary | null
  loading: boolean
  error?: string | null
  onBack: () => void
  onOpenProject: (project: LinearProjectSummary) => void
  onRefresh: () => void
  onOpenIssues?: () => void
}

type LinearCollectionNoticeProps = {
  errors?: LinearWorkspaceError[]
  hasMore?: boolean
  count: number
  label: string
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of ['name', 'label', 'displayName', 'title', 'status', 'body']) {
    const text = record[key]
    if (typeof text === 'string' && text.trim()) {
      return text.trim()
    }
  }
  return null
}

function dateLabel(value: string | null | undefined): string {
  if (!value) {
    return 'None'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function priorityLabel(priority: unknown, fallback: unknown): string {
  const fromFallback = textFromUnknown(fallback)
  if (fromFallback) {
    return fromFallback
  }
  if (typeof priority === 'number') {
    return priority === 0 ? 'None' : `P${priority}`
  }
  return textFromUnknown(priority) ?? 'None'
}

function projectProgress(project: LinearProjectLike): number | null {
  const progress = typeof project.progress === 'number' ? project.progress : null
  if (progress === null || !Number.isFinite(progress)) {
    return null
  }
  return progress <= 1 ? Math.round(progress * 100) : Math.round(progress)
}

function listLabels(values: unknown[] | undefined, limit: number): string[] {
  if (!Array.isArray(values)) {
    return []
  }
  return values
    .map((value) => textFromUnknown(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, limit)
}

function workspaceLabel(
  workspaceSelection: string | null | undefined,
  workspaceName?: string
): string | null {
  return workspaceSelection === 'all' && workspaceName ? workspaceName : null
}

function ProjectColorMark({ project }: { project: LinearProjectSummary }): React.JSX.Element {
  return (
    <span
      className="size-2.5 shrink-0 rounded-sm border border-border/50 bg-muted"
      style={project.color ? { backgroundColor: project.color } : undefined}
      aria-hidden
    />
  )
}

function ProjectStatusBadge({ project }: { project: LinearProjectLike }): React.JSX.Element {
  const label = textFromUnknown(project.status) ?? 'Backlog'
  return (
    <Badge variant="outline" className="max-w-full truncate text-[11px] font-medium">
      {label}
    </Badge>
  )
}

export function LinearCollectionNotice({
  errors,
  hasMore,
  count,
  label
}: LinearCollectionNoticeProps): React.JSX.Element | null {
  if (!hasMore && (!errors || errors.length === 0)) {
    return null
  }

  return (
    <div className="flex flex-none flex-col gap-2 border-t border-border/50 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
      {errors && errors.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {errors.map((error) => (
            <Badge key={`${error.workspaceId}-${error.type}`} variant="outline">
              {error.workspaceName ?? error.workspaceId}: {error.message}
            </Badge>
          ))}
        </div>
      ) : null}
      {hasMore ? (
        <div>
          Showing first {count} {label}. Search or open Linear for the full set.
        </div>
      ) : null}
    </div>
  )
}

export function LinearProjectTable({
  projects,
  loading,
  hasError,
  selectedProjectId,
  workspaceSelection,
  onSelectProject,
  onOpenProject,
  onUseProjectIssues
}: LinearProjectTableProps): React.JSX.Element {
  if (loading && projects.length === 0) {
    return (
      <div className="divide-y divide-border/50">
        {Array.from({ length: 10 }).map((_, index) => (
          <div
            key={index}
            className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(180px,1.5fr)_110px_100px_90px_120px_110px_80px_70px]"
          >
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-10 animate-pulse rounded bg-muted/60" />
            <div />
          </div>
        ))}
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {hasError ? 'Unable to load Linear projects' : 'No Linear projects found'}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasError ? 'Review the workspace error below, then refresh.' : 'Try search or refresh.'}
        </p>
      </div>
    )
  }

  return (
    <div className="min-w-[820px] divide-y divide-border/50">
      {projects.map((project) => {
        const projectLike = project as LinearProjectLike
        const selected = project.id === selectedProjectId
        const labels = listLabels(projectLike.labels, 2)
        const workspace = workspaceLabel(workspaceSelection, project.workspaceName)
        const progress = projectProgress(projectLike)
        return (
          <div
            key={`${project.workspaceId ?? 'workspace'}-${project.id}`}
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            data-current={selected ? 'true' : undefined}
            onClick={() => onSelectProject(project)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) {
                return
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectProject(project)
              }
            }}
            className={cn(
              'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(180px,1.5fr)_110px_100px_90px_120px_110px_80px_70px] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              selected && 'bg-accent'
            )}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <ProjectColorMark project={project} />
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {project.name}
                </span>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {workspace ? <span className="truncate">{workspace}</span> : null}
                {labels.map((label) => (
                  <Badge key={label} variant="outline" className="px-1.5 py-0 text-[10px]">
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <ProjectStatusBadge project={projectLike} />
            </div>
            <span className="truncate text-[12px] text-muted-foreground">
              {textFromUnknown(projectLike.health) ?? 'None'}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {priorityLabel(projectLike.priority, projectLike.priorityLabel)}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {textFromUnknown(projectLike.lead) ?? 'Unassigned'}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {dateLabel(project.targetDate)}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {typeof project.issueCount === 'number'
                ? project.issueCount
                : typeof project.scope === 'number'
                  ? project.scope
                  : progress !== null
                    ? `${progress}%`
                    : '-'}
            </span>
            <div className="flex items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
              {onUseProjectIssues ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(event) => {
                        event.stopPropagation()
                        onUseProjectIssues(project)
                      }}
                      aria-label={`Open ${project.name} issues`}
                    >
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    Issues
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenProject(project)
                    }}
                    aria-label={`Open ${project.name} in Linear`}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Open in Linear
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LinearCustomViewTable({
  views,
  model,
  loading,
  hasError,
  selectedViewId,
  workspaceSelection,
  onSelectView,
  onOpenView
}: LinearCustomViewTableProps): React.JSX.Element {
  if (loading && views.length === 0) {
    return (
      <div className="divide-y divide-border/50">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(220px,1.5fr)_120px_120px_120px_130px_60px]"
          >
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
            <div />
          </div>
        ))}
      </div>
    )
  }

  if (views.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {hasError ? `Unable to load ${model} views` : `No ${model} views found`}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasError
            ? 'Review the workspace error below, then refresh.'
            : 'Create or save views in Linear, then refresh.'}
        </p>
      </div>
    )
  }

  return (
    <div className="min-w-[680px] divide-y divide-border/50">
      {views.map((view) => {
        const selected = view.id === selectedViewId
        const workspace = workspaceLabel(workspaceSelection, view.workspaceName)
        return (
          <div
            key={`${view.workspaceId ?? 'workspace'}-${view.id}`}
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            data-current={selected ? 'true' : undefined}
            onClick={() => onSelectView(view)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) {
                return
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectView(view)
              }
            }}
            className={cn(
              'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(220px,1.5fr)_120px_120px_120px_130px_60px] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              selected && 'bg-accent'
            )}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Layers3 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {view.name}
                </span>
              </div>
              {view.description || workspace ? (
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {workspace ? `${workspace}${view.description ? ' · ' : ''}` : null}
                  {view.description}
                </div>
              ) : null}
            </div>
            <Badge variant="outline" className="w-fit capitalize">
              {view.model}
            </Badge>
            <span className="truncate text-[12px] text-muted-foreground">
              {view.shared ? 'Shared' : 'Private'}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {textFromUnknown(view.owner ?? view.creator) ?? 'Unknown'}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {view.updatedAt ? dateLabel(view.updatedAt) : 'Unknown'}
            </span>
            <div className="flex justify-end md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenView(view)
                    }}
                    aria-label={`Open ${view.name} in Linear`}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Open in Linear
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LinearProjectOverview({
  project,
  loading,
  error,
  onBack,
  onOpenProject,
  onRefresh,
  onOpenIssues
}: LinearProjectOverviewProps): React.JSX.Element {
  const projectLike = project as LinearProjectLike | null
  const progress = projectLike ? projectProgress(projectLike) : null
  const teams = listLabels(projectLike?.teams, 4)
  const labels = listLabels(projectLike?.labels, 4)
  const members = listLabels(projectLike?.members, 4)
  const milestones = listLabels(projectLike?.milestones, 4)
  const resources = listLabels(projectLike?.resources, 4)
  const latestUpdate = textFromUnknown(projectLike?.latestUpdate ?? projectLike?.lastUpdate)
  const body = projectLike?.content || projectLike?.description || projectLike?.summary || ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to projects">
            <ArrowLeft className="size-3.5" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {project?.name ?? 'Project'}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {project?.workspaceName
                ? `Linear / Projects / ${project.workspaceName}`
                : 'Linear / Projects'}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenIssues ? (
            <Button
              variant="outline"
              size="xs"
              onClick={onOpenIssues}
              className="gap-1 border-border/50 bg-background/70"
            >
              <Layers3 className="size-3.5" />
              Issues
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="xs"
            onClick={onRefresh}
            disabled={loading}
            className="gap-1 border-border/50 bg-background/70"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          {project ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onOpenProject(project)}
              className="gap-1 border-border/50 bg-background/70"
            >
              <ExternalLink className="size-3.5" />
              Linear
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-sleek">
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {loading && !project ? (
          <div className="space-y-3">
            <div className="h-5 w-1/3 animate-pulse rounded bg-muted/70" />
            <div className="h-24 animate-pulse rounded-md bg-muted/50" />
            <div className="h-40 animate-pulse rounded-md bg-muted/50" />
          </div>
        ) : projectLike ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-4">
              <section className="rounded-md border border-border/50 bg-muted/20 p-4">
                <div className="flex min-w-0 items-center gap-2">
                  <ProjectColorMark project={projectLike} />
                  <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                    {projectLike.name}
                  </h2>
                </div>
                {body ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {body}
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">No project description.</p>
                )}
              </section>

              {progress !== null ? (
                <section className="rounded-md border border-border/50 bg-muted/20 p-4">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">Progress</span>
                    <span className="text-muted-foreground">{progress}%</span>
                  </div>
                  <Progress value={Math.max(0, Math.min(100, progress))} />
                  {typeof projectLike.scope === 'number' ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      {projectLike.scope} scoped issues
                    </div>
                  ) : null}
                </section>
              ) : null}

              {milestones.length > 0 || resources.length > 0 || latestUpdate ? (
                <section className="rounded-md border border-border/50 bg-muted/20 p-4">
                  <h3 className="text-sm font-medium text-foreground">Planning</h3>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <MetadataList
                      icon={<FolderKanban className="size-3.5" />}
                      label="Milestones"
                      items={milestones}
                    />
                    <MetadataList
                      icon={<FileText className="size-3.5" />}
                      label="Resources"
                      items={resources}
                    />
                    <MetadataList
                      icon={<RefreshCw className="size-3.5" />}
                      label="Latest update"
                      items={latestUpdate ? [latestUpdate] : []}
                    />
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="min-w-0 space-y-3">
              <PropertyRow
                label="Status"
                value={textFromUnknown(projectLike.status) ?? 'Backlog'}
              />
              <PropertyRow label="Health" value={textFromUnknown(projectLike.health) ?? 'None'} />
              <PropertyRow
                label="Priority"
                value={priorityLabel(projectLike.priority, projectLike.priorityLabel)}
              />
              <PropertyRow
                label="Lead"
                value={textFromUnknown(projectLike.lead) ?? 'Unassigned'}
                icon={<UserRound className="size-3.5" />}
              />
              <PropertyRow
                label="Start"
                value={dateLabel(projectLike.startDate)}
                icon={<CalendarDays className="size-3.5" />}
              />
              <PropertyRow
                label="Target"
                value={dateLabel(projectLike.targetDate)}
                icon={<CalendarDays className="size-3.5" />}
              />
              <MetadataList label="Teams" items={teams} />
              <MetadataList label="Members" items={members} />
              <MetadataList label="Labels" items={labels} />
            </aside>
          </div>
        ) : (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Select a project to view its overview.
          </div>
        )}
      </div>
    </div>
  )
}

function PropertyRow({
  label,
  value,
  icon
}: {
  label: string
  value: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm text-foreground">{value}</div>
    </div>
  )
}

function MetadataList({
  icon,
  label,
  items
}: {
  icon?: React.ReactNode
  label: string
  items: string[]
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {icon}
        {label}
      </div>
      {items.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge key={item} variant="outline" className="max-w-full truncate">
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">None</div>
      )}
    </div>
  )
}
