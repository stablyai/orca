import React from 'react'
import { ExternalLink } from 'lucide-react'

import { getIntlLocale, translate } from '@/i18n/i18n'
import type { GitLabTodo } from '../../../../../shared/gitlab-types'

export type GitlabTodosListProps = {
  gitlabTodosLoading: boolean
  gitlabTodos: readonly GitLabTodo[]
  primaryRepo: { id: string } | null
}

export function GitlabTodosList({
  gitlabTodosLoading,
  gitlabTodos,
  primaryRepo
}: GitlabTodosListProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
      <div className="flex-none grid grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span>{translate('auto.components.TaskPage.8396825a14', 'Action')}</span>
        <span>{translate('auto.components.TaskPage.16cba35bee', 'Title')}</span>
        <span>{translate('auto.components.TaskPage.00022ec0ba', 'Project')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <div
        className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {gitlabTodosLoading && gitlabTodos.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="grid w-full gap-3 px-3 py-2 grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px]"
              >
                <div className="h-4 w-20 animate-pulse rounded bg-muted/70" />
                <div>
                  <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                </div>
                <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div />
              </div>
            ))}
          </div>
        ) : null}
        {!gitlabTodosLoading && gitlabTodos.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            {primaryRepo
              ? translate(
                  'auto.components.TaskPage.d591aac6ae',
                  'No pending todos. You’re all caught up!'
                )
              : translate(
                  'auto.components.TaskPage.03da966159',
                  'Select a project so we can authenticate to GitLab.'
                )}
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {gitlabTodos.map((todo) => (
            <div
              role="button"
              tabIndex={0}
              key={todo.id}
              onClick={() => void window.api.shell.openUrl(todo.targetUrl)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void window.api.shell.openUrl(todo.targetUrl)
                }
              }}
              className="grid w-full cursor-pointer gap-3 px-3 py-2 text-left grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_50px] hover:bg-muted/50"
              title={
                todo.targetType === 'MergeRequest'
                  ? translate('auto.components.TaskPage.a0544fb653', 'MR !{{value0}}', {
                      value0: todo.targetIid ?? ''
                    })
                  : todo.targetType === 'Issue'
                    ? translate('auto.components.TaskPage.e9b6955dcd', 'Issue #{{value0}}', {
                        value0: todo.targetIid ?? ''
                      })
                    : todo.targetType
              }
            >
              <span className="text-xs text-muted-foreground">
                {/* Why: GitLab action_name is snake_case (review_requested); swap _ for space so the row reads like a sentence. */}
                {todo.actionName.replace(/_/g, ' ')}
              </span>
              <span className="min-w-0 truncate text-sm">{todo.targetTitle}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {todo.projectPath}
              </span>
              <span className="text-xs text-muted-foreground">
                {todo.updatedAt ? new Date(todo.updatedAt).toLocaleDateString(getIntlLocale()) : ''}
              </span>
              <span className="flex justify-end">
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
