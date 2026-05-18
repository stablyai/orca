import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GetRateLimitResult, GitHubRateLimitSnapshot } from '../../../../shared/types'

const REFRESH_INTERVAL_MS = 60_000

type BucketKey = 'core' | 'search' | 'graphql'

type BucketMeta = {
  key: BucketKey
  label: string
  description: string
}

const BUCKETS: BucketMeta[] = [
  { key: 'core', label: 'REST', description: 'REST API' },
  { key: 'search', label: 'Search', description: 'Search API' },
  { key: 'graphql', label: 'GraphQL', description: 'GraphQL API' }
]

export function formatGitHubRateLimitReset(resetAt: number): string {
  const deltaSec = Math.max(0, resetAt - Math.floor(Date.now() / 1000))
  if (deltaSec < 60) {
    return `${deltaSec}s`
  }
  const mins = Math.round(deltaSec / 60)
  return `${mins}m`
}

export function toneForGitHubBucket(remaining: number, limit: number): 'ok' | 'warn' | 'crit' {
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

export function useGitHubRateLimitSnapshot(options?: { autoRefresh?: boolean }): {
  snapshot: GitHubRateLimitSnapshot | null
  hasError: boolean
  isFetching: boolean
  refresh: (force?: boolean) => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<GitHubRateLimitSnapshot | null>(null)
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
            ? await callRuntimeRpc<GetRateLimitResult>(target, 'github.rateLimit', params ?? {}, {
                timeoutMs: 30_000
              })
            : ((await window.api.gh.rateLimit(params)) as GetRateLimitResult | undefined)
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
    const fetchIfVisible = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void refresh(false)
      }
    }
    void refresh(false)
    const handle = window.setInterval(fetchIfVisible, REFRESH_INTERVAL_MS)
    window.addEventListener('focus', fetchIfVisible)
    document.addEventListener('visibilitychange', fetchIfVisible)
    return () => {
      window.clearInterval(handle)
      window.removeEventListener('focus', fetchIfVisible)
      document.removeEventListener('visibilitychange', fetchIfVisible)
    }
  }, [autoRefresh, refresh])

  return { snapshot, hasError, isFetching, refresh }
}

function GitHubRateLimitRows({
  snapshot
}: {
  snapshot: GitHubRateLimitSnapshot
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 font-mono">
      {BUCKETS.map((b) => {
        const v = snapshot[b.key]
        const tone = toneForGitHubBucket(v.remaining, v.limit)
        return (
          <div key={b.key} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{b.description}</span>
            <span
              className={cn(
                'text-foreground',
                tone === 'crit' && 'text-red-600 dark:text-red-300',
                tone === 'warn' && 'text-amber-700 dark:text-amber-300'
              )}
            >
              {v.remaining} of {v.limit} left · resets in {formatGitHubRateLimitReset(v.resetAt)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function GitHubRateLimitPanel({ className }: { className?: string }): React.JSX.Element {
  const { snapshot, hasError, isFetching, refresh } = useGitHubRateLimitSnapshot()

  return (
    <div className={cn('space-y-3 rounded-md border border-border/60 p-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Gauge className="size-4" />
            GitHub API Budget
          </div>
          <p className="text-xs text-muted-foreground">
            Orca uses REST, Search, and GraphQL through the GitHub CLI.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={isFetching}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-secondary-foreground transition hover:bg-accent disabled:opacity-50"
          aria-label="Refresh GitHub API budget"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </button>
      </div>
      {hasError ? (
        <div className="text-xs text-muted-foreground">GitHub API budget is unavailable.</div>
      ) : snapshot ? (
        <GitHubRateLimitRows snapshot={snapshot} />
      ) : (
        <div className="text-xs text-muted-foreground">Loading GitHub API budget…</div>
      )}
    </div>
  )
}
