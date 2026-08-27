import React from 'react'
import { ExternalLink, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '../relative-time'
import { translate } from '@/i18n/i18n'
import type { KanbanTaskDetails } from '../../../../../shared/kanban-types'

export type KanbanTaskDetailProps = {
  task: KanbanTaskDetails
  onClose: () => void
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </dt>
  )
}

export function KanbanTaskDetail({ task, onClose }: KanbanTaskDetailProps): React.JSX.Element {
  const executors = task.executors.map((person) => person.name).join(', ')
  const observers = task.observers.map((person) => person.name).join(', ')

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{task.id}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task detail">
          <X className="size-4" />
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-4 py-3"
        style={{ scrollbarGutter: 'stable' }}
      >
        <dl className="space-y-4">
          {task.result ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.result', 'Result')}
              </SectionLabel>
              <dd className="whitespace-pre-wrap text-sm text-foreground">{task.result}</dd>
            </div>
          ) : null}
          {task.description ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.description', 'Description')}
              </SectionLabel>
              <dd className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.description}
              </dd>
            </div>
          ) : null}
          <div className="space-y-1">
            <SectionLabel>{translate('auto.components.kanban.detail.roles', 'Roles')}</SectionLabel>
            <dd className="space-y-1 text-sm text-foreground">
              <p>
                {translate('auto.components.kanban.detail.executors', 'Executors')}:{' '}
                <span className="text-muted-foreground">{executors || '—'}</span>
              </p>
              <p>
                {translate('auto.components.kanban.detail.observers', 'Observers')}:{' '}
                <span className="text-muted-foreground">{observers || '—'}</span>
              </p>
              <p>
                {translate('auto.components.kanban.detail.createdBy', 'Created by')}:{' '}
                <span className="text-muted-foreground">{task.createdBy?.name ?? '—'}</span>
              </p>
            </dd>
          </div>
          {task.comments.length > 0 ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.comments', 'Comments')}
              </SectionLabel>
              <dd className="space-y-2">
                {task.comments.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-md border border-border/50 bg-muted/30 px-3 py-2"
                  >
                    <p className="text-xs font-medium text-foreground">
                      {comment.author?.name ?? '—'}{' '}
                      <span className="font-normal text-muted-foreground">
                        {comment.createdAt ? formatRelativeTime(comment.createdAt) : ''}
                      </span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                      {comment.text}
                    </p>
                  </div>
                ))}
              </dd>
            </div>
          ) : null}
          {task.blockedBy.length > 0 ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.dependencies', 'Dependencies')}
              </SectionLabel>
              <dd className="flex flex-wrap gap-1.5">
                {task.blockedBy.map((id) => (
                  <Badge key={id} variant="outline">
                    {id}
                  </Badge>
                ))}
              </dd>
            </div>
          ) : null}
          {task.repositoryUrls.length > 0 ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.repositories', 'Repositories')}
              </SectionLabel>
              <dd className="space-y-1">
                {task.repositoryUrls.map((url) => (
                  <p key={url} className="truncate font-mono text-xs text-foreground">
                    {url}
                  </p>
                ))}
              </dd>
            </div>
          ) : null}
          {task.attachments.length > 0 ? (
            <div className="space-y-1">
              <SectionLabel>
                {translate('auto.components.kanban.detail.attachments', 'Attachments')}
              </SectionLabel>
              <dd className="space-y-1">
                {task.attachments.map((attachment) => (
                  <p key={attachment.url} className="truncate text-xs text-foreground">
                    {attachment.name}
                    {attachment.size !== null ? ` (${attachment.size} B)` : ''}
                  </p>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="mt-4 border-t border-border/60 pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.api.shell.openUrl(task.url)}
            aria-label={translate(
              'auto.components.kanban.detail.openBrowser',
              'Open Kanban task {{value0}} in browser',
              { value0: task.id }
            )}
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.kanban.detail.openBrowserLabel', 'Open in browser')}
          </Button>
        </div>
      </div>
    </div>
  )
}
