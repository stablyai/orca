import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GetGitLabRateLimitResult, GitLabRateLimitSnapshot } from '../../../../shared/types'

const REFRESH_INTERVAL_MS = 60_000

export function formatGitLabRateLimitReset(resetAt: number | null): string {
  if (resetAt === null) {
    return 'unknown'
  }
  const deltaSec = Math.max(0, resetAt - Math.floor(Date.now() / 1000))
  if (deltaSec < 60) {
    return `${deltaSec}s`
  }
  const mins = Math.round(deltaSec / 60)
  return `${mins}m`
}

export function toneForGitLabBucket(remaining: number, limit: number): 'ok' | 'warn' | 'crit' {
  if (limit <= 0) {
    return 'ok'
  }
  const pct = remaining / limit
  if (pct < 0.1) {
    return 'crit'
  }
  if (pct < 0.25) {
    return 'warn'
  }
  return 'ok'
}

export function useGitLabRateLimitSnapshot(options?: { autoRefresh?: boolean }): {
  snapshot: GitLabRateLimitSnapshot | null
  hasError: boolean
  isFetching: boolean
  refresh: (force?: boolean) => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<GitLabRateLimitSnapshot | null>(null)
  const [hasError, setHasError] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const settings = useAppStore((s) => s.settings)
  const latestToken = useRef(0)
  const autoRefresh = options?.autoRefresh ?? true

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const token = ++latestToken.current
      setIsFetching(true)
      try {
        const target = getActiveRuntimeTarget(settings)
        const params = force ? { force: true } : undefined
        const res =
          target.kind === 'environment'
            ? await callRuntimeRpc<GetGitLabRateLimitResult>(
                target,
                'gitlab.rateLimit',
                params ?? {},
                { timeoutMs: 30_000 }
              )
            : ((await window.api.gl.rateLimit(params)) as GetGitLabRateLimitResult | undefined)
        if (token !== latestToken.current) {
          return
        }
        if (res?.ok) {
          setSnapshot(res.snapshot)
          setHasError(false)
        } else {
          setHasError(true)
        }
      } catch {
        if (token === latestToken.current) {
          setHasError(true)
        }
      } finally {
        if (token === latestToken.current) {
          setIsFetching(false)
        }
      }
    },
    [settings]
  )

  useEffect(() => {
    if (!autoRefresh) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => void refresh(false),
      intervalMs: REFRESH_INTERVAL_MS
    })
  }, [autoRefresh, refresh])

  return { snapshot, hasError, isFetching, refresh }
}

function GitLabRateLimitRows({
  snapshot
}: {
  snapshot: GitLabRateLimitSnapshot
}): React.JSX.Element {
  const rest = snapshot.rest
  if (!rest) {
    return (
      <div className="text-xs text-muted-foreground">
        This GitLab host did not return rate-limit headers.
      </div>
    )
  }
  const tone = toneForGitLabBucket(rest.remaining, rest.limit)
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">REST API</span>
        <span
          className={cn(
            'tabular-nums text-foreground',
            tone === 'crit' && 'text-red-600 dark:text-red-300',
            tone === 'warn' && 'text-amber-700 dark:text-amber-300'
          )}
        >
          {rest.remaining} of {rest.limit} left, resets in{' '}
          {formatGitLabRateLimitReset(rest.resetAt)}
        </span>
      </div>
    </div>
  )
}

export function GitLabRateLimitPanel({ className }: { className?: string }): React.JSX.Element {
  const { snapshot, hasError, isFetching, refresh } = useGitLabRateLimitSnapshot()

  return (
    <div className={cn('space-y-3 rounded-md border border-border/60 p-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Gauge className="size-4" />
            GitLab API Budget
          </div>
          <p className="text-xs text-muted-foreground">Orca uses REST through the GitLab CLI.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => void refresh(true)}
          disabled={isFetching}
          aria-label="Refresh GitLab API budget"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>
      {hasError ? (
        <div className="text-xs text-muted-foreground">GitLab API budget is unavailable.</div>
      ) : snapshot ? (
        <GitLabRateLimitRows snapshot={snapshot} />
      ) : (
        <div className="text-xs text-muted-foreground">Loading GitLab API budget...</div>
      )}
    </div>
  )
}
