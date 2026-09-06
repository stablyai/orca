import React from 'react'
import { FileText, GitPullRequest, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'

type Props = {
  row: GitHubProjectRow
  draggable: boolean
  onOpenDialog?: () => void
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

export default function ProjectBoardCard({
  row,
  draggable,
  onOpenDialog,
  onDragStart,
  onDragEnd
}: Props): React.JSX.Element {
  const restricted = row.itemType === 'REDACTED'
  // Why: mirrors the roadmap bar — a redacted card must never render or
  // announce an empty name.
  const title = restricted
    ? translate('auto.components.github.project.ProjectBoardCard.aa5cdf1345', 'Restricted item')
    : row.content.title
  const clickable = !restricted && row.itemType !== 'DRAFT_ISSUE'
  const Glyph =
    row.itemType === 'PULL_REQUEST'
      ? GitPullRequest
      : row.itemType === 'DRAFT_ISSUE'
        ? FileText
        : restricted
          ? Lock
          : null
  return (
    <div
      role="listitem"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-label={
        row.content.number == null
          ? title
          : translate(
              'auto.components.github.project.ProjectBoardCard.325bbbf366',
              '{{value0}} — {{value1}}',
              { value0: `#${row.content.number}`, value1: title }
            )
      }
      className={cn(
        'rounded-md border border-border/60 bg-background p-2 shadow-xs',
        draggable && 'cursor-grab active:cursor-grabbing',
        restricted && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-1.5">
        {Glyph ? <Glyph className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : null}
        <div className="min-w-0 flex-1">
          {clickable ? (
            <button
              type="button"
              onClick={onOpenDialog}
              className="block w-full text-left text-xs font-medium leading-snug hover:underline"
            >
              <span className="line-clamp-2">{title}</span>
            </button>
          ) : (
            <span
              className={cn(
                'line-clamp-2 text-xs font-medium leading-snug',
                restricted && 'italic'
              )}
            >
              {title}
            </span>
          )}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            {row.content.number == null ? null : (
              <span className="shrink-0">#{row.content.number}</span>
            )}
            {row.content.repository ? (
              <span className="truncate">{row.content.repository}</span>
            ) : null}
          </div>
        </div>
        {row.content.assignees.length > 0 ? (
          <div className="flex shrink-0 -space-x-1.5">
            {row.content.assignees.slice(0, 3).map((user) =>
              user.avatarUrl ? (
                <img
                  key={user.login}
                  src={user.avatarUrl}
                  alt={user.login}
                  title={user.login}
                  className="size-4 rounded-full border border-background"
                />
              ) : (
                <span
                  key={user.login}
                  title={user.login}
                  className="flex size-4 items-center justify-center rounded-full border border-background bg-muted text-[8px] uppercase"
                >
                  {user.login.charAt(0)}
                </span>
              )
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
