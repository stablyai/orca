import React from 'react'
import { AlertTriangle, Loader, Pin } from 'lucide-react'
import { GhAuthErrorHelp } from './GhAuthErrorHelp'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubProjectViewSummary } from '../../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'

export function ProjectPickerSection({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="py-1">
      <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

export function ProjectPickerRow({
  title,
  subtitle,
  onClick,
  zombie,
  canPin,
  onPin,
  onRemovePin
}: {
  title: string
  subtitle: string
  onClick: () => void
  zombie?: boolean
  canPin?: boolean
  onPin?: () => void
  onRemovePin?: () => void
}): React.JSX.Element {
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-[10px] text-muted-foreground">{subtitle}</span>
      </button>
      {zombie ? (
        <div className="flex items-center gap-1">
          <AlertTriangle className="size-3.5 text-amber-500" />
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onRemovePin}
          >
            {translate('auto.components.github.project.ProjectPicker.5009ffc2f3', 'Remove pin')}
          </button>
        </div>
      ) : null}
      {canPin ? (
        <button
          type="button"
          title={translate('auto.components.github.project.ProjectPicker.8ab5447c64', 'Pin')}
          className="can-hover:opacity-0 group-hover:opacity-100"
          onClick={onPin}
        >
          <Pin className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function ProjectViewPickStep({
  loading,
  views,
  onPick,
  onBack
}: {
  loading: boolean
  views: GitHubProjectViewSummary[]
  onPick: (view: GitHubProjectViewSummary) => void | Promise<void>
  onBack: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border/50 p-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.github.project.ProjectPicker.a51b3337ab', '← Back')}
        </button>
        <span className="text-xs font-medium">
          {translate('auto.components.github.project.ProjectPicker.9bf55fa1e8', 'Choose a view')}
        </span>
        <span />
      </div>
      <div className="max-h-[340px] overflow-y-auto p-1 scrollbar-sleek">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader className="size-3 animate-spin" />
            {translate('auto.components.github.project.ProjectPicker.72a05c04a6', 'Loading views…')}
          </div>
        ) : views.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectPicker.9b36829267',
              'No views found.'
            )}
          </div>
        ) : (
          views.map((view) => <ProjectViewPickerRow key={view.id} view={view} onPick={onPick} />)
        )}
      </div>
    </div>
  )
}

function ProjectViewPickerRow({
  view,
  onPick
}: {
  view: GitHubProjectViewSummary
  onPick: (view: GitHubProjectViewSummary) => void | Promise<void>
}): React.JSX.Element {
  const supported = view.layout === 'TABLE_LAYOUT'
  const layoutLabel =
    view.layout === 'TABLE_LAYOUT'
      ? translate('auto.components.github.project.ProjectPicker.1a2b8e512e', 'Table')
      : view.layout === 'BOARD_LAYOUT'
        ? translate(
            'auto.components.github.project.ProjectPicker.d34ef9b554',
            'Board (unsupported)'
          )
        : translate(
            'auto.components.github.project.ProjectPicker.ab1a2c357d',
            'Roadmap (unsupported)'
          )
  return (
    <button
      type="button"
      disabled={!supported}
      onClick={() => void onPick(view)}
      className={cn(
        'flex w-full flex-col items-start rounded px-2 py-1 text-left',
        supported ? 'hover:bg-muted/50' : 'cursor-not-allowed opacity-50'
      )}
    >
      <span className="text-sm">{view.name}</span>
      <span className="text-[10px] text-muted-foreground">{layoutLabel}</span>
    </button>
  )
}

export function ProjectPickerPartialFailures({
  failures
}: {
  failures: { owner: string; message: string }[]
}): React.JSX.Element {
  const summary =
    failures.length === 1 && failures[0].owner !== '*'
      ? `Couldn't load projects from ${failures[0].owner}.`
      : `Some organizations didn't load (${failures.length}).`
  const detail = failures
    .map((failure) => `${failure.owner === '*' ? 'orgs' : failure.owner}: ${failure.message}`)
    .join('\n')
  return (
    <div
      className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
      title={detail}
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <div>
          <div>{summary}</div>
          <div className="mt-0.5 text-[11px] opacity-80">
            {translate(
              'auto.components.github.project.ProjectPicker.96739284c3',
              'Paste a project URL below to reach missing ones.'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ProjectPickerError({
  error,
  host
}: {
  error: GitHubProjectViewError
  host: string
}): React.JSX.Element {
  if (error.type === 'auth_required' || error.type === 'scope_missing') {
    return (
      <GhAuthErrorHelp
        error={error as GitHubProjectViewError & { type: 'auth_required' | 'scope_missing' }}
        variant="banner"
        host={host}
      />
    )
  }
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <div>{error.message}</div>
    </div>
  )
}
