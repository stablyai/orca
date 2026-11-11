import React from 'react'
import { getCheckConclusion } from '@/components/pr-check-counts'
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest
} from 'lucide-react'
import type { PRInfo } from '../../../../../../shared/github/pull-request-types'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

export const PullRequestIcon = GitPullRequest

export function checkPresentationKey(check: PRCheckDetail): string {
  return check.gitlabAllowedFailure === true && check.conclusion === 'neutral'
    ? 'gitlabAllowedFailure'
    : getCheckConclusion(check)
}

export const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  gitlabAllowedFailure: AlertTriangle,
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  cancelled: CircleX,
  skipped: CircleMinus,
  neutral: CircleDashed,
  timed_out: CircleX,
  action_required: AlertTriangle,
  stale: CircleDashed
}

export const CHECK_COLOR: Record<string, string> = {
  gitlabAllowedFailure: 'text-amber-500',
  success: 'text-emerald-500',
  failure: 'text-rose-500',
  pending: 'text-amber-500',
  cancelled: 'text-muted-foreground/60',
  skipped: 'text-muted-foreground/60',
  neutral: 'text-muted-foreground',
  timed_out: 'text-rose-500',
  action_required: 'text-amber-500',
  stale: 'text-muted-foreground'
}

export function prStateColor(state: PRInfo['state']): string {
  switch (state) {
    case 'merged':
      return 'bg-purple-500/15 text-purple-500 border-purple-500/20'
    case 'closed':
      return 'bg-destructive/10 text-destructive border-destructive/20'
    case 'draft':
      return 'bg-muted text-muted-foreground/70 border-border'
    case 'open':
      return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20'
  }
}
