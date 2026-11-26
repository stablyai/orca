import { useCallback, useSyncExternalStore } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderUsageStatusLabel } from '../../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { useAppStore } from '../../../../store/index'
import { Button } from '../../../ui/button'
import { useAccountOwnerUsage } from '../../../status-bar/usage/use-owner-usage-rate-limits'

export type ServerCliUsage = {
  owner: RuntimeClientTarget
  label: string
}

type ServerCliProvider = 'grok' | 'cursor'

const FIX_BY_SIGN_IN_FAILURES: ReadonlySet<string> = new Set([
  'delegated-refresh-required',
  'stale-token',
  'missing-credentials'
])

const refreshesInFlight = new Map<string, Promise<void>>()
const refreshListeners = new Set<() => void>()

function notifyRefreshListeners(): void {
  refreshListeners.forEach((listener) => listener())
}

function subscribeRefreshes(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => {
    refreshListeners.delete(listener)
  }
}

// Why: a forced read refreshes every provider on the host, so both buttons share one.
function joinHostRefresh(hostKey: string, run: () => Promise<void>): Promise<void> {
  const running = refreshesInFlight.get(hostKey)
  if (running) {
    return running
  }
  const started = run().finally(() => {
    refreshesInFlight.delete(hostKey)
    notifyRefreshListeners()
  })
  refreshesInFlight.set(hostKey, started)
  notifyRefreshListeners()
  return started
}

function hasUsageReading(provider: ServerCliProvider, usage: ProviderRateLimits): boolean {
  return provider === 'grok'
    ? Boolean(usage.weekly || usage.monthly)
    : (usage.buckets?.length ?? 0) > 0 || Boolean(usage.monthly)
}

export function useServerCliUsage(
  server: ServerCliUsage,
  provider: ServerCliProvider
): {
  usage: ProviderRateLimits | null
  usageKnown: boolean
  refreshing: boolean
  refresh: (() => void) | null
} {
  const local = useAppStore((s) => s.rateLimits)
  // Why: a non-host owner would resolve to this device's usage, which must never sit under a server header.
  const owner =
    server.owner.kind === 'environment' ? { target: server.owner, wslHostDistro: null } : null
  const { rateLimits, refreshRemote } = useAccountOwnerUsage(owner, local, server.label)
  const hostKey = server.owner.kind === 'environment' ? server.owner.environmentId : ''
  const refreshing = useSyncExternalStore(
    subscribeRefreshes,
    () => refreshesInFlight.has(hostKey),
    () => false
  )
  const refresh = useCallback(() => {
    if (refreshRemote) {
      void joinHostRefresh(hostKey, refreshRemote)
    }
  }, [hostKey, refreshRemote])
  const usage = rateLimits[provider]
  return {
    usage,
    // Why: the unreachable-host message already shows in the status line; repeating it as a usage row misleads.
    usageKnown: usage !== null && !usage.usageMetadata?.unverifiableOwner,
    refreshing,
    refresh: refreshRemote ? refresh : null
  }
}

function describeServerCliStatus(
  provider: ServerCliProvider,
  label: string,
  usage: ProviderRateLimits | null,
  t: Translate
): { title: string; body: string | null; signedIn: boolean } {
  if (!usage) {
    return {
      title:
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
            ),
      body: null,
      signedIn: false
    }
  }
  if (usage.status === 'fetching' || usage.status === 'idle') {
    return {
      title: t(
        'auto.components.settings.ServerCliUsageStatus.checkingOn',
        'Checking usage on {{host}}…',
        { host: label }
      ),
      body: null,
      signedIn: false
    }
  }
  if (usage.status === 'ok' && hasUsageReading(provider, usage)) {
    return {
      title: t(
        'auto.components.settings.ServerCliUsageStatus.signedInOn',
        'Signed in on {{host}}',
        { host: label }
      ),
      body:
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
            ),
      signedIn: true
    }
  }
  const failureKind = usage.usageMetadata?.failureKind
  const needsSignIn =
    (failureKind !== undefined && FIX_BY_SIGN_IN_FAILURES.has(failureKind)) ||
    usage.usageMetadata?.ownerNotSetUp !== undefined
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
  return {
    title: getProviderUsageStatusLabel(usage, t),
    body: needsSignIn ? hint : (usage.error ?? null),
    signedIn: false
  }
}

export function ServerCliUsageRow({
  provider,
  label,
  usage,
  refreshing,
  onRefresh
}: {
  provider: ServerCliProvider
  label: string
  usage: ProviderRateLimits | null
  refreshing: boolean
  onRefresh: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const { title, body, signedIn } = describeServerCliStatus(provider, label, usage, t)

  return (
    <div className="flex items-start gap-3 py-3">
      <ShieldCheck
        className={cn(
          'mt-0.5 size-4 shrink-0',
          signedIn ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium">{title}</p>
        {body ? <p className="text-xs text-muted-foreground">{body}</p> : null}
      </div>
      <Button
        variant="outline"
        size="xs"
        disabled={refreshing || !onRefresh}
        onClick={() => onRefresh?.()}
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
