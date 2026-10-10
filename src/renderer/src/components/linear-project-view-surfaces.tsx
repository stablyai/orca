import React from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Layers3, LoaderCircle, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import type { LinearWorkspaceError } from '../../../shared/linear/workspace-types'
import {
  LinearCustomViewTableContent,
  type LinearCustomViewTableContentProps
} from './linear-custom-view-table-content'
import { LinearProjectOverviewContent } from './linear-project-overview-content'
import {
  LinearProjectTableContent,
  type LinearProjectTableContentProps
} from './linear-project-table-content'

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
  onLoadMore?: () => void
  loading?: boolean
  loadMoreLabel?: string
}

export function LinearCollectionNotice({
  errors,
  hasMore,
  count,
  label,
  onLoadMore,
  loading = false,
  loadMoreLabel = 'Load more'
}: LinearCollectionNoticeProps): React.JSX.Element | null {
  if (!hasMore && (!errors || errors.length === 0)) {
    return null
  }

  return (
    <div className="flex flex-none flex-col gap-2 border-t border-border/50 bg-muted/50 text-xs text-muted-foreground">
      {errors && errors.length > 0 ? (
        <div className={cn('flex flex-wrap gap-2 px-3', hasMore ? 'pt-2' : 'py-2')}>
          {errors.map((error) => (
            <Badge key={`${error.workspaceId}-${error.type}`} variant="outline">
              {error.workspaceName ?? error.workspaceId}: {error.message}
            </Badge>
          ))}
        </div>
      ) : null}
      {hasMore ? (
        <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3">
          {onLoadMore ? null : (
            <span>
              {translate(
                'auto.components.linear.project.view.surfaces.06b887d622',
                'Showing first'
              )}{' '}
              {count} {label}
              {translate(
                'auto.components.linear.project.view.surfaces.98730088a6',
                '. Search or open Linear for the full set.'
              )}
            </span>
          )}
          {onLoadMore ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onLoadMore}
              disabled={loading}
              className="inline-flex h-auto w-24 shrink-0 items-center justify-center gap-0.5 rounded-md border-0 bg-transparent px-2 py-1 text-sm text-muted-foreground shadow-none transition hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              {loading ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  {translate('auto.components.linear.project.view.surfaces.93e1f6bfca', 'Loading')}
                </>
              ) : (
                <>
                  {loadMoreLabel}
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function LinearProjectTable(props: LinearProjectTableContentProps): React.JSX.Element {
  return <LinearProjectTableContent {...props} />
}

export function LinearCustomViewTable(props: LinearCustomViewTableContentProps): React.JSX.Element {
  return <LinearCustomViewTableContent {...props} />
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onBack}
            aria-label={translate(
              'auto.components.linear.project.view.surfaces.5f79bc76b0',
              'Back to projects'
            )}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {project?.name ??
                translate('auto.components.linear.project.view.surfaces.85607ff793', 'Project')}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {project?.workspaceName
                ? translate(
                    'auto.components.linear.project.view.surfaces.906b5e4cb8',
                    'Linear / Projects / {{value0}}',
                    { value0: project.workspaceName }
                  )
                : translate(
                    'auto.components.linear.project.view.surfaces.f2cc1e0ff6',
                    'Linear / Projects'
                  )}
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
              {translate('auto.components.linear.project.view.surfaces.ee3d2caabd', 'Issues')}
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
            {translate('auto.components.linear.project.view.surfaces.a9785c7158', 'Refresh')}
          </Button>
          {project ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onOpenProject(project)}
              className="gap-1 border-border/50 bg-background/70"
            >
              <ExternalLink className="size-3.5" />
              {translate('auto.components.linear.project.view.surfaces.7b147907dc', 'Linear')}
            </Button>
          ) : null}
        </div>
      </div>
      <LinearProjectOverviewContent project={project} loading={loading} error={error} />
    </div>
  )
}
