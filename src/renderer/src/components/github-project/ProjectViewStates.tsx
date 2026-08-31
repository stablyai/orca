import React from 'react'
import { ExternalLink, KanbanSquare, Map as MapIcon, Table as TableIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { GhAuthErrorHelp } from './GhAuthErrorHelp'
import type { GitHubProjectViewSummary } from '../../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'

const ORCA_FEATURE_REQUEST_URL = 'https://github.com/stablyai/orca/issues/new'

export function ProjectViewTabStrip({
  views,
  activeViewId,
  onPick
}: {
  views: GitHubProjectViewSummary[]
  activeViewId: string | null
  onPick: (viewId: string) => void
}): React.JSX.Element {
  return (
    <div className="project-view-tab-strip flex min-h-[41px] min-w-0 flex-none items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-border/50 bg-muted/20 px-3 pt-3">
      {views.map((view) => (
        <ProjectViewTab
          key={view.id}
          view={view}
          active={view.id === activeViewId}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

function ProjectViewTab({
  view,
  active,
  onPick
}: {
  view: GitHubProjectViewSummary
  active: boolean
  onPick: (viewId: string) => void
}): React.JSX.Element {
  const supported = view.layout === 'TABLE_LAYOUT'
  const layoutLabel =
    view.layout === 'BOARD_LAYOUT'
      ? 'Board'
      : view.layout === 'ROADMAP_LAYOUT'
        ? 'Roadmap'
        : 'Table'
  const Icon =
    view.layout === 'BOARD_LAYOUT'
      ? KanbanSquare
      : view.layout === 'ROADMAP_LAYOUT'
        ? MapIcon
        : TableIcon
  const tab = (
    <button
      type="button"
      disabled={!supported}
      onClick={() => onPick(view.id)}
      title={
        supported
          ? view.name
          : translate(
              'auto.components.github.project.ProjectViewWrapper.2edf5e7e77',
              "{{value0}} — Orca doesn't support {{value1}} project views yet. File a feature request at {{value2}}.",
              { value0: view.name, value1: layoutLabel, value2: ORCA_FEATURE_REQUEST_URL }
            )
      }
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-x border-t px-3 py-1.5 text-xs',
        active
          ? '-mb-px border-border/60 bg-background text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-background/40 hover:text-foreground',
        !supported &&
          'pointer-events-none cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground'
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn(active && 'font-medium')}>{view.name}</span>
    </button>
  )
  if (supported) {
    return tab
  }
  const message = `Orca doesn't support ${layoutLabel} project views yet.`
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          tabIndex={0}
          aria-label={translate(
            'auto.components.github.project.ProjectViewWrapper.55de4fb57a',
            '{{value0}}. {{value1}} File a feature request at {{value2}}.',
            { value0: view.name, value1: message, value2: ORCA_FEATURE_REQUEST_URL }
          )}
          className="inline-flex shrink-0 cursor-not-allowed rounded-t-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {tab}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={8} className="w-72 p-3">
        <div className="space-y-2">
          <p className="text-xs leading-5 text-muted-foreground">
            {message}{' '}
            {translate(
              'auto.components.github.project.ProjectViewWrapper.1bf8c01c8b',
              'Switch to a Table view to work with this project in Orca.'
            )}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void window.api.shell.openUrl(ORCA_FEATURE_REQUEST_URL)}
          >
            {translate(
              'auto.components.github.project.ProjectViewWrapper.4d2a77a119',
              'File feature request'
            )}
            <ExternalLink className="size-3" />
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function ProjectViewErrorState({
  error,
  totalCount,
  host,
  onOpenInGitHub
}: {
  error: GitHubProjectViewError
  totalCount?: number
  host?: string
  onOpenInGitHub: () => void
}): React.JSX.Element {
  if (error.type === 'auth_required' || error.type === 'scope_missing') {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
        <GhAuthErrorHelp
          error={error as GitHubProjectViewError & { type: 'auth_required' | 'scope_missing' }}
          host={host}
        />
        <OpenInGitHubButton onClick={onOpenInGitHub} />
      </div>
    )
  }
  const copy =
    error.type === 'too_large'
      ? `This view has ${totalCount ?? 'many'} items — too large to render in Orca. Narrow the view's filter on GitHub.`
      : error.type === 'unsupported_layout'
        ? 'Orca only renders table views yet. This is a Board or Roadmap view.'
        : error.type === 'not_found'
          ? 'Could not find this project or view.'
          : error.type === 'schema_drift'
            ? 'Could not read this project view.'
            : error.message
  return (
    <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
      <div className="text-muted-foreground">{copy}</div>
      <OpenInGitHubButton onClick={onOpenInGitHub} />
    </div>
  )
}

function OpenInGitHubButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      <ExternalLink className="mr-1 size-3.5" />
      {translate('auto.components.github.project.ProjectViewWrapper.23b87ba9f7', 'Open in GitHub')}
    </Button>
  )
}

export function ProjectTableSkeleton(): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label={translate(
        'auto.components.github.project.ProjectViewWrapper.463f1205c0',
        'Loading project view'
      )}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2">
        <div className="grid grid-cols-6 items-center gap-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-3 w-20 animate-pulse rounded bg-muted/70" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-border/30">
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={index} className="grid min-h-10 grid-cols-5 items-center gap-3 px-3 py-2">
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-2/5 animate-pulse rounded-full bg-muted/60" />
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  )
}
