import { useMemo, useState } from 'react'
import { ChevronDown, GitBranch, GitPullRequest } from 'lucide-react'
import type { GitHubPRStack, GitHubPRStackEntry } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

function stackEntryStatus(entry: GitHubPRStackEntry): string {
  if (entry.state === 'merged') {
    return translate('auto.components.right.sidebar.GitHubPRStackMap.status.merged', 'merged')
  }
  if (entry.state === 'closed') {
    return translate('auto.components.right.sidebar.GitHubPRStackMap.status.closed', 'closed')
  }
  if (entry.state === 'draft') {
    return translate('auto.components.right.sidebar.GitHubPRStackMap.status.draft', 'draft')
  }
  if (entry.mergeable === 'CONFLICTING') {
    return translate('auto.components.right.sidebar.GitHubPRStackMap.status.conflicts', 'conflicts')
  }
  if (entry.checksStatus === 'failure') {
    return translate(
      'auto.components.right.sidebar.GitHubPRStackMap.status.checksFailed',
      'checks failed'
    )
  }
  if (entry.checksStatus === 'pending') {
    return translate(
      'auto.components.right.sidebar.GitHubPRStackMap.status.checksPending',
      'checks pending'
    )
  }
  if (entry.reviewDecision === 'CHANGES_REQUESTED') {
    return translate(
      'auto.components.right.sidebar.GitHubPRStackMap.status.changesRequested',
      'changes requested'
    )
  }
  if (entry.reviewDecision === 'REVIEW_REQUIRED') {
    return translate(
      'auto.components.right.sidebar.GitHubPRStackMap.status.reviewNeeded',
      'review needed'
    )
  }
  if (entry.reviewDecision === 'APPROVED') {
    return translate('auto.components.right.sidebar.GitHubPRStackMap.status.approved', 'approved')
  }
  return translate('auto.components.right.sidebar.GitHubPRStackMap.status.open', 'open')
}

export function GitHubPRStackMap({
  stack,
  currentPRNumber,
  onOpenPullRequest
}: {
  stack: GitHubPRStack
  currentPRNumber: number
  onOpenPullRequest: (url: string, event: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const entries = useMemo(
    () => [...(stack.entries ?? [])].sort((a, b) => b.position - a.position),
    [stack.entries]
  )

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-md border border-border"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={
            open
              ? translate(
                  'auto.components.right.sidebar.GitHubPRStackMap.collapse',
                  'Collapse stack #{{value0}}',
                  { value0: stack.number }
                )
              : translate(
                  'auto.components.right.sidebar.GitHubPRStackMap.expand',
                  'Expand stack #{{value0}}',
                  { value0: stack.number }
                )
          }
        >
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-semibold text-foreground">
            {translate(
              'auto.components.right.sidebar.GitHubPRStackMap.title',
              'Stack #{{value0}}',
              { value0: stack.number }
            )}
          </span>
          <span className="text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.GitHubPRStackMap.position',
              '{{value0}} of {{value1}} · {{value2}}',
              { value0: stack.position, value1: stack.size, value2: stack.baseRefName }
            )}
          </span>
          <ChevronDown
            className={cn(
              'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-180'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border">
        {entries.length > 0 ? (
          <div className="py-1">
            {entries.map((entry) => {
              const current = entry.number === currentPRNumber
              return (
                <button
                  key={entry.number}
                  type="button"
                  data-stack-pr-number={entry.number}
                  data-current={current ? 'true' : undefined}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    current && 'bg-accent'
                  )}
                  onClick={(event) => onOpenPullRequest(entry.url, event)}
                >
                  <span className="w-8 shrink-0 font-medium text-foreground">#{entry.number}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {stackEntryStatus(entry)}
                  </span>
                </button>
              )
            })}
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{stack.baseRefName}</span>
            </div>
          </div>
        ) : (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.GitHubPRStackMap.unavailable',
              'Stack details are temporarily unavailable.'
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
