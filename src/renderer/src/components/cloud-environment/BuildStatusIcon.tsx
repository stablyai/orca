import { useEffect, useState } from 'react'
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Loader2,
  MinusCircle,
  Pause
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StepStatus } from './build-steps'
import type { EnvironmentBuildStatus } from './cloud-environment-types'

export function stepStatusFromBuild(status: EnvironmentBuildStatus): StepStatus {
  if (status === 'starting' || status === 'running' || status === 'snapshotting') {
    return 'running'
  }
  return status
}

/** Decorative: callers always put the status in words next to it (or in an sr-only label). */
export function BuildStatusIcon({
  status,
  className
}: {
  /** `paused`: the build may still run, but the live stream is down (frozen, not spinning). */
  status: StepStatus | 'paused'
  className?: string
}): React.JSX.Element {
  const base = cn('size-4 shrink-0', className)
  switch (status) {
    case 'running':
      // Reduced motion gets a static dot: a frozen spinner reads as a hang.
      return (
        <>
          <Loader2
            aria-hidden
            className={cn(base, 'animate-spin text-sky-600 motion-reduce:hidden dark:text-sky-400')}
          />
          <CircleDot
            aria-hidden
            className={cn(base, 'hidden text-sky-600 motion-reduce:block dark:text-sky-400')}
          />
        </>
      )
    case 'paused':
      return <Pause aria-hidden className={cn(base, 'text-muted-foreground')} />
    case 'succeeded':
      return <CircleCheck aria-hidden className={cn(base, 'text-status-success')} />
    case 'failed':
      return <CircleX aria-hidden className={cn(base, 'text-destructive')} />
    case 'canceled':
      return <Ban aria-hidden className={cn(base, 'text-muted-foreground')} />
    case 'skipped':
      return <MinusCircle aria-hidden className={cn(base, 'text-muted-foreground/50')} />
    case 'pending':
      return <CircleDashed aria-hidden className={cn(base, 'text-muted-foreground/60')} />
  }
}

/** Wall clock that ticks only while `enabled` (a running build); otherwise frozen at mount. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [enabled, intervalMs])
  return now
}
