import React from 'react'
import {
  CircleCheck,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert
} from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { cn } from '@/lib/class-names'
import { ZOTZ_PR_TONE_TEXT, zotzPrTone, type ZotzPrStatusKind } from './zotz-pr-status'

/** One glyph per PR state; running checks spin so a glance tells work from waiting. */
export function ZotzPrStatusIcon({
  status,
  className
}: {
  status: ZotzPrStatusKind
  className?: string
}): React.JSX.Element {
  const color = ZOTZ_PR_TONE_TEXT[zotzPrTone(status)]
  const icon = cn('size-3.5 shrink-0', color, className)
  switch (status) {
    case 'pending':
      return <LoadingSpinner className={icon} />
    case 'failing':
      return <CircleX className={icon} />
    case 'conflicts':
      return <TriangleAlert className={icon} />
    case 'ready':
      return <CircleCheck className={icon} />
    case 'merged':
      return <GitMerge className={icon} />
    case 'closed':
      return <GitPullRequestClosed className={icon} />
    case 'draft':
      return <GitPullRequestDraft className={icon} />
    case 'open':
      return <CircleDot className={icon} />
  }
}
