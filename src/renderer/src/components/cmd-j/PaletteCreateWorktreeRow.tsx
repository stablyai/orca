import React, { useEffect, useState } from 'react'
import { Github, Gitlab, Plus } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { CommandItem } from '@/components/ui/command'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/worktree-palette-create-action'
import type { CmdJTaskUrlCreatePreview } from '@/lib/worktree-palette-task-url-match'
import type { LinearIssue } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

function TaskUrlProviderIcon({
  provider
}: {
  provider: CmdJTaskUrlCreatePreview['provider']
}): React.JSX.Element {
  if (provider === 'github') {
    return <Github className="size-3" aria-hidden="true" />
  }
  if (provider === 'gitlab') {
    return <Gitlab className="size-3" aria-hidden="true" />
  }
  return <JiraIcon className="size-3" />
}

export function PaletteCreateWorktreeRow({
  className,
  createWorktreeName,
  linearIdentifier,
  linearIssue,
  linearPending,
  showLinearLoadingFeedback,
  taskUrlPreview,
  onSelect
}: {
  className: string
  createWorktreeName: string
  linearIdentifier: string | null
  linearIssue: Pick<LinearIssue, 'identifier' | 'title'> | null
  linearPending: boolean
  showLinearLoadingFeedback: boolean
  taskUrlPreview: CmdJTaskUrlCreatePreview | null
  onSelect: () => void
}): React.JSX.Element {
  const showLinearPreview = linearPending || linearIssue !== null
  const linearPreviewLabel = linearIssue
    ? translate(
        'worktreeJumpPalette.linearIssue.createLabel',
        'Create worktree from Linear issue {{value0}}: {{value1}}',
        { value0: linearIssue.identifier, value1: linearIssue.title }
      )
    : linearPending && showLinearLoadingFeedback
      ? translate(
          'worktreeJumpPalette.linearIssue.loadingLabel',
          'Loading Linear issue {{value0}}',
          { value0: linearIdentifier ?? '' }
        )
      : linearPending
        ? translate(
            'worktreeJumpPalette.linearIssue.pendingLabel',
            'Create worktree from Linear issue {{value0}}',
            { value0: linearIdentifier ?? '' }
          )
        : undefined
  const previewLabel = showLinearPreview
    ? linearPreviewLabel
    : (taskUrlPreview?.createLabel ?? undefined)
  const [showTaskUrlLoadingFeedback, setShowTaskUrlLoadingFeedback] = useState(false)
  useEffect(() => {
    if (!taskUrlPreview?.loading) {
      setShowTaskUrlLoadingFeedback(false)
      return
    }
    setShowTaskUrlLoadingFeedback(false)
    const timer = window.setTimeout(() => setShowTaskUrlLoadingFeedback(true), 200)
    return () => window.clearTimeout(timer)
  }, [taskUrlPreview?.identifier, taskUrlPreview?.loading])

  return (
    <CommandItem
      value={CREATE_WORKTREE_ITEM_ID}
      onSelect={onSelect}
      aria-label={previewLabel}
      aria-busy={linearPending || Boolean(taskUrlPreview?.loading && !showLinearPreview)}
      data-cmd-j-linear-issue-preview={showLinearPreview ? 'true' : undefined}
      data-cmd-j-linear-issue-state={
        linearIssue ? 'resolved' : linearPending ? 'loading' : undefined
      }
      data-cmd-j-task-url-preview={taskUrlPreview && !showLinearPreview ? 'true' : undefined}
      data-cmd-j-task-url-provider={
        taskUrlPreview && !showLinearPreview ? taskUrlPreview.provider : undefined
      }
      data-cmd-j-task-url-state={
        taskUrlPreview && !showLinearPreview
          ? taskUrlPreview.loading
            ? 'loading'
            : 'resolved'
          : undefined
      }
      className={className}
    >
      {showLinearPreview ? (
        <>
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/25 text-muted-foreground/70">
            <LinearIcon className="size-3" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-[12px] font-semibold text-muted-foreground">
                {linearIssue?.identifier ?? linearIdentifier}
              </span>
              {linearIssue ? (
                <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                  {linearIssue.title}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {linearIssue || !showLinearLoadingFeedback
                ? translate(
                    'worktreeJumpPalette.linearIssue.createHint',
                    'Create worktree from Linear issue'
                  )
                : translate('worktreeJumpPalette.linearIssue.loadingHint', 'Loading Linear issue…')}
            </div>
          </div>
        </>
      ) : taskUrlPreview ? (
        <>
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/25 text-muted-foreground/70">
            <TaskUrlProviderIcon provider={taskUrlPreview.provider} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-[12px] font-semibold text-muted-foreground">
                {taskUrlPreview.identifier}
              </span>
              <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                {taskUrlPreview.subtitle}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {taskUrlPreview.loading && showTaskUrlLoadingFeedback
                ? translate('worktreeJumpPalette.taskUrl.loadingHint', 'Loading {{value0}}…', {
                    value0: taskUrlPreview.kindLabel
                  })
                : translate(
                    'worktreeJumpPalette.taskUrl.createHint',
                    'Create worktree from {{value0}}',
                    { value0: taskUrlPreview.kindLabel }
                  )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
            <Plus size={13} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">
              {translate(
                'auto.components.WorktreeJumpPalette.95be6587d3',
                'Create worktree "{{value0}}"',
                { value0: createWorktreeName }
              )}
            </div>
          </div>
        </>
      )}
    </CommandItem>
  )
}
