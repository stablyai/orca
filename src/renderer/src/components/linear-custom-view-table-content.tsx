import React from 'react'
import { ExternalLink, Layers3 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LinearCustomViewSummary } from '../../../shared/linear/project-types'
import {
  linearProjectDateLabel,
  linearProjectUnknownText,
  linearProjectWorkspaceLabel
} from './linear-project-presentation'

export type LinearCustomViewTableContentProps = {
  views: LinearCustomViewSummary[]
  loading: boolean
  hasError?: boolean
  selectedViewId?: string | null
  workspaceSelection?: string | null
  onSelectView: (view: LinearCustomViewSummary) => void
  onOpenView: (view: LinearCustomViewSummary) => void
}

function LinearCustomViewTableSkeleton(): React.JSX.Element {
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

function LinearCustomViewTableEmpty({ hasError }: { hasError?: boolean }): React.JSX.Element {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">
        {hasError
          ? translate(
              'auto.components.linear.project.view.surfaces.c0a50f96a4',
              'Unable to load views'
            )
          : translate('auto.components.linear.project.view.surfaces.ef90b21366', 'No views found')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasError
          ? translate(
              'auto.components.linear.project.view.surfaces.f4c79cff5f',
              'Review the workspace error below, then refresh.'
            )
          : translate(
              'auto.components.linear.project.view.surfaces.9f0f51fd9e',
              'Create or save views in Linear, then refresh.'
            )}
      </p>
    </div>
  )
}

export function LinearCustomViewTableContent({
  views,
  loading,
  hasError,
  selectedViewId,
  workspaceSelection,
  onSelectView,
  onOpenView
}: LinearCustomViewTableContentProps): React.JSX.Element {
  if (loading && views.length === 0) {
    return <LinearCustomViewTableSkeleton />
  }
  if (views.length === 0) {
    return <LinearCustomViewTableEmpty hasError={hasError} />
  }

  return (
    <div className="min-w-[680px] divide-y divide-border/50">
      {views.map((view) => {
        const selected = view.id === selectedViewId
        const workspace = linearProjectWorkspaceLabel(workspaceSelection, view.workspaceName)
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
              {view.shared
                ? translate('auto.components.linear.project.view.surfaces.27d91cb1a6', 'Shared')
                : translate('auto.components.linear.project.view.surfaces.f059181bd9', 'Private')}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {linearProjectUnknownText(view.owner ?? view.creator) ??
                translate('auto.components.linear.project.view.surfaces.20b9d09b7d', 'Unknown')}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {view.updatedAt
                ? linearProjectDateLabel(view.updatedAt)
                : translate('auto.components.linear.project.view.surfaces.20b9d09b7d', 'Unknown')}
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
                    aria-label={translate(
                      'auto.components.linear.project.view.surfaces.7616c986c6',
                      'Open {{value0}} in Linear',
                      { value0: view.name }
                    )}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.linear.project.view.surfaces.aac9a4afc6',
                    'Open in Linear'
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}
