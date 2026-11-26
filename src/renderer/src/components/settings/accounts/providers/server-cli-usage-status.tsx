import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderUsageStatusLabel } from '../../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { Button } from '../../../ui/button'

export type ServerCliUsage = {
  owner: RuntimeClientTarget
  label: string
  usage: ProviderRateLimits | null
}

type ServerCliProvider = 'grok' | 'cursor'

export function serverCliUsagesFor(
  owner: RuntimeClientTarget,
  label: string,
  rateLimits: RateLimitState | null
): Record<ServerCliProvider, ServerCliUsage> {
  return {
    grok: { owner, label, usage: rateLimits?.grok ?? null },
    cursor: { owner, label, usage: rateLimits?.cursor ?? null }
  }
}

const USAGE_REFRESH_TIMEOUT_MS = 30_000

function hasUsageReading(provider: ServerCliProvider, usage: ProviderRateLimits): boolean {
  return provider === 'grok'
    ? Boolean(usage.weekly || usage.monthly)
    : (usage.buckets?.length ?? 0) > 0 || Boolean(usage.monthly)
}

function newerUsage(
  streamed: ProviderRateLimits | null,
  refreshed: ProviderRateLimits | null
): ProviderRateLimits | null {
  if (!streamed || !refreshed) {
    return refreshed ?? streamed
  }
  return refreshed.updatedAt >= streamed.updatedAt ? refreshed : streamed
}

export function useServerCliUsage(
  server: ServerCliUsage,
  provider: ServerCliProvider
): {
  usage: ProviderRateLimits | null
  refreshing: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const ownerKey = server.owner.kind === 'environment' ? server.owner.environmentId : 'local'
  const [refreshed, setRefreshed] = useState<{
    ownerKey: string
    usage: ProviderRateLimits | null
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const liveOwnerKey = useRef<string | null>(ownerKey)

  // A refresh that settles after unmount or an owner switch describes another host.
  useEffect(() => {
    liveOwnerKey.current = ownerKey
    return () => {
      liveOwnerKey.current = null
    }
  }, [ownerKey])

  const refresh = async (): Promise<void> => {
    const requestedKey = ownerKey
    setRefreshing(true)
    setError(null)
    try {
      const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState }>(
        server.owner,
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: USAGE_REFRESH_TIMEOUT_MS }
      )
      if (liveOwnerKey.current === requestedKey) {
        setRefreshed({ ownerKey: requestedKey, usage: snapshot.rateLimits[provider] })
      }
    } catch (cause) {
      if (liveOwnerKey.current === requestedKey) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (liveOwnerKey.current === requestedKey) {
        setRefreshing(false)
      }
    }
  }

  return {
    usage: newerUsage(server.usage, refreshed?.ownerKey === ownerKey ? refreshed.usage : null),
    refreshing,
    error,
    refresh
  }
}

export function ServerCliUsageRow({
  provider,
  label,
  usage,
  refreshing,
  error,
  onRefresh
}: {
  provider: ServerCliProvider
  label: string
  usage: ProviderRateLimits | null
  refreshing: boolean
  error: string | null
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const reading =
    usage !== null &&
    hasUsageReading(provider, usage) &&
    usage.usageMetadata?.failureKind !== 'delegated-refresh-required'
  const hint =
    provider === 'grok'
      ? t(
          'auto.components.settings.ServerCliUsageStatus.grokHint',
          'Run grok on {{host}} and wait for it to start, signing in if asked. Then click Refresh usage.',
          { host: label }
        )
      : t(
          'auto.components.settings.ServerCliUsageStatus.cursorHint',
          'Sign in to Cursor on {{host}} (Cursor IDE or cursor-agent login), then click Refresh usage.',
          { host: label }
        )
  let title: string
  let body: string
  if (reading) {
    title = t('auto.components.settings.ServerCliUsageStatus.signedInOn', 'Signed in on {{host}}', {
      host: label
    })
    body =
      provider === 'grok'
        ? t(
            'auto.components.settings.ServerCliUsageStatus.readsGrok',
            'Orca reads the Grok CLI sign-in on {{host}}.',
            { host: label }
          )
        : t(
            'auto.components.settings.ServerCliUsageStatus.readsCursor',
            'Orca reads the Cursor sign-in on {{host}}.',
            { host: label }
          )
  } else if (usage) {
    title = getProviderUsageStatusLabel(usage, t)
    body = hint
  } else {
    title =
      provider === 'grok'
        ? t(
            'auto.components.settings.ServerCliUsageStatus.notReportedGrok',
            '{{host}} has not reported Grok usage',
            { host: label }
          )
        : t(
            'auto.components.settings.ServerCliUsageStatus.notReportedCursor',
            '{{host}} has not reported Cursor usage',
            { host: label }
          )
    body = hint
  }

  return (
    <div className="flex items-start gap-3 py-3">
      <ShieldCheck
        className={cn(
          'mt-0.5 size-4 shrink-0',
          reading ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <Button
        variant="outline"
        size="xs"
        disabled={refreshing}
        onClick={onRefresh}
        className="shrink-0"
      >
        {refreshing ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        {t('auto.components.settings.ServerCliUsageStatus.refreshUsage', 'Refresh usage')}
      </Button>
    </div>
  )
}
