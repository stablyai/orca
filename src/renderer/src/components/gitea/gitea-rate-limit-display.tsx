import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  GetGiteaRateLimitResult,
  GiteaAuthDiagnostic,
  GiteaRateLimitSnapshot
} from '../../../../shared/gitea-types'
import { getProviderRateLimitScope } from '@/components/settings/provider-account-scope'
import { ProviderHostScopeControl } from '@/components/settings/ProviderHostScopeControl'
import {
  formatGitLabRateLimitReset,
  toneForGitLabBucket
} from '../gitlab/gitlab-rate-limit-display'
import { translate } from '@/i18n/i18n'

const REFRESH_INTERVAL_MS = 60_000

export async function fetchGiteaRateLimit(
  target: RuntimeClientTarget,
  force: boolean
): Promise<GetGiteaRateLimitResult | undefined> {
  const params = force ? { force: true } : undefined
  if (target.kind === 'environment') {
    return callRuntimeRpc<GetGiteaRateLimitResult>(target, 'gitea.rateLimit', params ?? {}, {
      timeoutMs: 30_000
    })
  }
  return window.api.gitea.rateLimit(params)
}

export async function fetchGiteaAuthDiagnostic(
  target: RuntimeClientTarget
): Promise<GiteaAuthDiagnostic | undefined> {
  if (target.kind === 'environment') {
    return callRuntimeRpc<GiteaAuthDiagnostic>(
      target,
      'gitea.diagnoseAuth',
      {},
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gitea.diagnoseAuth()
}

export function summarizeGiteaAuthDiagnostic(diagnostic: GiteaAuthDiagnostic): string {
  if (!diagnostic.teaAvailable) {
    return diagnostic.envTokenInProcess
      ? translate(
          'auto.components.gitea.gitea.rate.limit.display.envTokenOnly',
          'tea CLI not installed; using {{value0}}.',
          { value0: diagnostic.envTokenInProcess }
        )
      : translate(
          'auto.components.gitea.gitea.rate.limit.display.teaMissing',
          'tea CLI is not installed.'
        )
  }
  if (!diagnostic.authenticated) {
    return translate(
      'auto.components.gitea.gitea.rate.limit.display.teaSignedOut',
      'tea CLI is not signed in. Run tea login add.'
    )
  }
  return diagnostic.activeHost
    ? translate(
        'auto.components.gitea.gitea.rate.limit.display.teaSignedInHost',
        'tea CLI signed in to {{value0}}.',
        { value0: diagnostic.activeHost }
      )
    : translate(
        'auto.components.gitea.gitea.rate.limit.display.teaSignedIn',
        'tea CLI is signed in.'
      )
}

export function useGiteaRateLimitSnapshot(
  target: RuntimeClientTarget,
  options?: { autoRefresh?: boolean }
): {
  snapshot: GiteaRateLimitSnapshot | null
  diagnostic: GiteaAuthDiagnostic | null
  hasError: boolean
  isFetching: boolean
  refresh: (force?: boolean) => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<GiteaRateLimitSnapshot | null>(null)
  const [diagnostic, setDiagnostic] = useState<GiteaAuthDiagnostic | null>(null)
  const [hasError, setHasError] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const latestToken = useRef(0)
  const autoRefresh = options?.autoRefresh ?? true

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const token = ++latestToken.current
      setIsFetching(true)
      try {
        const [res, diag] = await Promise.all([
          fetchGiteaRateLimit(target, force),
          fetchGiteaAuthDiagnostic(target).catch(() => undefined)
        ])
        if (token !== latestToken.current) {
          return
        }
        setDiagnostic(diag ?? null)
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
    [target]
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

  return { snapshot, diagnostic, hasError, isFetching, refresh }
}

function GiteaRateLimitRows({ snapshot }: { snapshot: GiteaRateLimitSnapshot }): React.JSX.Element {
  const rest = snapshot.rest
  if (!rest) {
    return (
      <div className="text-xs text-muted-foreground">
        {translate(
          'auto.components.gitea.gitea.rate.limit.display.noHeaders',
          'This Gitea host did not return rate-limit headers.'
        )}
      </div>
    )
  }
  const tone = toneForGitLabBucket(rest.remaining, rest.limit)
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">
        {translate('auto.components.gitea.gitea.rate.limit.display.rest', 'REST API')}
      </span>
      <span
        className={cn(
          'tabular-nums text-foreground',
          tone === 'crit' && 'text-red-600 dark:text-red-300',
          tone === 'warn' && 'text-amber-700 dark:text-amber-300'
        )}
      >
        {translate(
          'auto.components.gitea.gitea.rate.limit.display.remainingOfLimit',
          '{{remaining}} of {{limit}} left, resets in {{reset}}',
          {
            remaining: rest.remaining,
            limit: rest.limit,
            reset: formatGitLabRateLimitReset(rest.resetAt)
          }
        )}
      </span>
    </div>
  )
}

export function GiteaRateLimitPanel({
  className,
  target
}: {
  className?: string
  /** The host chosen at the top of Settings. */
  target: RuntimeClientTarget
}): React.JSX.Element {
  const { snapshot, diagnostic, hasError, isFetching, refresh } = useGiteaRateLimitSnapshot(target)
  const budgetScope = getProviderRateLimitScope(target, 'Gitea')

  return (
    <div className={cn('space-y-3 rounded-md border border-border/60 p-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Gauge className="size-4" />
            {translate('auto.components.gitea.gitea.rate.limit.display.title', 'Gitea API Budget')}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.gitea.gitea.rate.limit.display.description',
              'Orca uses REST through the Gitea CLI (tea).'
            )}
          </p>
          <ProviderHostScopeControl
            labelPrefix={translate(
              'auto.components.gitea.gitea.rate.limit.display.budgetScopePrefix',
              'Budget scope'
            )}
            scope={budgetScope}
            className="text-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => void refresh(true)}
          disabled={isFetching}
          aria-label={translate(
            'auto.components.gitea.gitea.rate.limit.display.refresh',
            'Refresh Gitea API budget'
          )}
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>
      {diagnostic ? (
        <div className="text-xs text-muted-foreground">
          {summarizeGiteaAuthDiagnostic(diagnostic)}
        </div>
      ) : null}
      {hasError ? (
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.gitea.gitea.rate.limit.display.unavailable',
            'Gitea API budget is unavailable.'
          )}
        </div>
      ) : snapshot ? (
        <GiteaRateLimitRows snapshot={snapshot} />
      ) : (
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.gitea.gitea.rate.limit.display.loading',
            'Loading Gitea API budget...'
          )}
        </div>
      )}
    </div>
  )
}
