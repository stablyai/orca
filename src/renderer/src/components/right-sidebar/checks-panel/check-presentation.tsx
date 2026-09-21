import React from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest
} from 'lucide-react'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'

export const PullRequestIcon = GitPullRequest

export const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
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
