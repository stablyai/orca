import React from 'react'
import { CalendarDays, FileText, FolderKanban, RefreshCw, UserRound } from 'lucide-react'

import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import type {
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import {
  linearProjectDateLabel,
  linearProjectMetadataLabels,
  linearProjectPriorityLabel,
  linearProjectProgressPercent,
  linearProjectUnknownText,
  type LinearProjectPresentation
} from './linear-project-presentation'
import {
  LinearProjectMetadataList,
  LinearProjectPropertyRow
} from './linear-project-overview-metadata'
import { LinearProjectColorMark } from './linear-project-table-content'

export type LinearProjectOverviewContentProps = {
  project: LinearProjectDetail | LinearProjectSummary | null
  loading: boolean
  error?: string | null
}

export function LinearProjectOverviewContent({
  project,
  loading,
  error
}: LinearProjectOverviewContentProps): React.JSX.Element {
  const presentation = project as LinearProjectPresentation | null
  const progress = presentation ? linearProjectProgressPercent(presentation) : null
  const teams = linearProjectMetadataLabels(presentation?.teams, 4)
  const labels = linearProjectMetadataLabels(presentation?.labels, 4)
  const members = linearProjectMetadataLabels(presentation?.members, 4)
  const milestones = linearProjectMetadataLabels(presentation?.milestones, 4)
  const resources = linearProjectMetadataLabels(presentation?.resources, 4)
  const latestUpdate = linearProjectUnknownText(
    presentation?.latestUpdate ?? presentation?.lastUpdate
  )
  const body = presentation?.content || presentation?.description || presentation?.summary || ''

  return (
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
      ) : presentation ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-4">
            <section className="rounded-md border border-border/50 bg-muted/20 p-4">
              <div className="flex min-w-0 items-center gap-2">
                <LinearProjectColorMark project={presentation} />
                <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                  {presentation.name}
                </h2>
              </div>
              {body ? (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {body}
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  {translate(
                    'auto.components.linear.project.view.surfaces.bb5664d456',
                    'No project description.'
                  )}
                </p>
              )}
            </section>

            {progress !== null ? (
              <section className="rounded-md border border-border/50 bg-muted/20 p-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">
                    {translate(
                      'auto.components.linear.project.view.surfaces.563501f191',
                      'Progress'
                    )}
                  </span>
                  <span className="text-muted-foreground">{progress}%</span>
                </div>
                <Progress value={Math.max(0, Math.min(100, progress))} />
                {typeof presentation.scope === 'number' ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {presentation.scope}{' '}
                    {translate(
                      'auto.components.linear.project.view.surfaces.3ad562bdf4',
                      'scoped issues'
                    )}
                  </div>
                ) : null}
              </section>
            ) : null}

            {milestones.length > 0 || resources.length > 0 || latestUpdate ? (
              <section className="rounded-md border border-border/50 bg-muted/20 p-4">
                <h3 className="text-sm font-medium text-foreground">
                  {translate('auto.components.linear.project.view.surfaces.5d99315fb8', 'Planning')}
                </h3>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <LinearProjectMetadataList
                    icon={<FolderKanban className="size-3.5" />}
                    label={translate(
                      'auto.components.linear.project.view.surfaces.bb1405eff8',
                      'Milestones'
                    )}
                    items={milestones}
                  />
                  <LinearProjectMetadataList
                    icon={<FileText className="size-3.5" />}
                    label={translate(
                      'auto.components.linear.project.view.surfaces.c8db98b73b',
                      'Resources'
                    )}
                    items={resources}
                  />
                  <LinearProjectMetadataList
                    icon={<RefreshCw className="size-3.5" />}
                    label={translate(
                      'auto.components.linear.project.view.surfaces.0a6a5a7dd6',
                      'Latest update'
                    )}
                    items={latestUpdate ? [latestUpdate] : []}
                  />
                </div>
              </section>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-3">
            <LinearProjectPropertyRow
              label={translate('auto.components.linear.project.view.surfaces.9ddb58edbd', 'Status')}
              value={linearProjectUnknownText(presentation.status) ?? 'Backlog'}
            />
            <LinearProjectPropertyRow
              label={translate('auto.components.linear.project.view.surfaces.f5ef24cf46', 'Health')}
              value={linearProjectUnknownText(presentation.health) ?? 'None'}
            />
            <LinearProjectPropertyRow
              label={translate(
                'auto.components.linear.project.view.surfaces.3be47aed6f',
                'Priority'
              )}
              value={linearProjectPriorityLabel(presentation.priority, presentation.priorityLabel)}
            />
            <LinearProjectPropertyRow
              label={translate('auto.components.linear.project.view.surfaces.111bef9aa8', 'Lead')}
              value={linearProjectUnknownText(presentation.lead) ?? 'Unassigned'}
              icon={<UserRound className="size-3.5" />}
            />
            <LinearProjectPropertyRow
              label={translate('auto.components.linear.project.view.surfaces.3fb6473111', 'Start')}
              value={linearProjectDateLabel(presentation.startDate)}
              icon={<CalendarDays className="size-3.5" />}
            />
            <LinearProjectPropertyRow
              label={translate('auto.components.linear.project.view.surfaces.25a2196732', 'Target')}
              value={linearProjectDateLabel(presentation.targetDate)}
              icon={<CalendarDays className="size-3.5" />}
            />
            <LinearProjectMetadataList
              label={translate('auto.components.linear.project.view.surfaces.c5f79616c3', 'Teams')}
              items={teams}
            />
            <LinearProjectMetadataList
              label={translate(
                'auto.components.linear.project.view.surfaces.65bda65159',
                'Members'
              )}
              items={members}
            />
            <LinearProjectMetadataList
              label={translate('auto.components.linear.project.view.surfaces.1748d3b9af', 'Labels')}
              items={labels}
            />
          </aside>
        </div>
      ) : (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.linear.project.view.surfaces.e1fa97d21d',
            'Select a project to view its overview.'
          )}
        </div>
      )}
    </div>
  )
}
