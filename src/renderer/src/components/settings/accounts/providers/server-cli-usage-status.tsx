import { useCallback, useSyncExternalStore } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  currentOwnerAccountsStream,
  readOwnerAccounts,
  subscribeOwnerAccounts,
  type OwnerAccountsFailure,
  type OwnerAccountsState,
  type OwnerAccountsStreamToken
} from '@/runtime/provider-accounts/observations/owner-accounts-stream'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { getProviderUsageStatusLabel } from '../../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { Button } from '../../../ui/button'
import { describeUnverifiableOwner } from '../../../status-bar/usage/owner-usage-rate-limits'
import {
  refreshOwnerAccountsUsage,
  useAccountOwnerUsage
} from '../../../status-bar/usage/use-owner-usage-rate-limits'

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

// Why: nothing from this device may stand in for the server's usage.
const NO_LOCAL_USAGE = createEmptyRateLimitState()

const refreshesInFlight = new Map<string, Promise<void>>()
// Why: an error belongs to the host observation it failed in; a newer snapshot or stream supersedes it.
const refreshErrors = new Map<
  string,
  { stream: OwnerAccountsStreamToken | null; state: OwnerAccountsState | null; message: string }
>()
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
function joinHostRefresh(hostKey: string): Promise<void> {
  const running = refreshesInFlight.get(hostKey)
  if (running) {
    return running
  }
  refreshErrors.delete(hostKey)
  const startedOn = currentOwnerAccountsStream(hostKey)
  const started = refreshOwnerAccountsUsage(hostKey)
    .catch((cause: unknown) => {
      const stream = currentOwnerAccountsStream(hostKey)
      if (stream === startedOn) {
        refreshErrors.set(hostKey, {
          stream,
          state: readOwnerAccounts(hostKey),
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    })
    .finally(() => {
      refreshesInFlight.delete(hostKey)
      notifyRefreshListeners()
    })
  refreshesInFlight.set(hostKey, started)
  notifyRefreshListeners()
  return started
}

function currentRefreshError(hostKey: string): string | null {
  const failed = refreshErrors.get(hostKey)
  return failed &&
    failed.stream === currentOwnerAccountsStream(hostKey) &&
    failed.state === readOwnerAccounts(hostKey)
    ? failed.message
    : null
}

function hasUsageWindow(provider: ServerCliProvider, usage: ProviderRateLimits): boolean {
  return provider === 'grok'
    ? Boolean(usage.weekly || usage.monthly)
    : (usage.buckets?.length ?? 0) > 0 || Boolean(usage.monthly)
}

const NO_HOST_STREAM = (): (() => void) => () => {}

export function useServerCliUsage(
  server: ServerCliUsage,
  provider: ServerCliProvider
): {
  usage: ProviderRateLimits | null
  usageKnown: boolean
  hostFailure: OwnerAccountsFailure | null
  hostAnswered: boolean
  authConfigured: boolean
  refreshing: boolean
  refreshError: string | null
  refresh: (() => void) | null
} {
  // Why: a non-host owner would resolve to this device's usage, which must never sit under a server header.
  const owner =
    server.owner.kind === 'environment' ? { target: server.owner, wslHostDistro: null } : null
  const { rateLimits } = useAccountOwnerUsage(owner, NO_LOCAL_USAGE, server.label)
  const hostKey = server.owner.kind === 'environment' ? server.owner.environmentId : null
  const subscribeHost = useCallback(
    (listener: () => void) =>
      hostKey ? subscribeOwnerAccounts(hostKey, listener) : NO_HOST_STREAM(),
    [hostKey]
  )
  const hostState = useSyncExternalStore(subscribeHost, () =>
    hostKey ? readOwnerAccounts(hostKey) : null
  )
  const refreshing = useSyncExternalStore(
    subscribeRefreshes,
    () => hostKey !== null && refreshesInFlight.has(hostKey),
    () => false
  )
  const refreshError = useSyncExternalStore(
    subscribeRefreshes,
    () => (hostKey ? currentRefreshError(hostKey) : null),
    () => null
  )
  const refresh = useCallback(() => {
    if (hostKey) {
      void joinHostRefresh(hostKey)
    }
  }, [hostKey])
  const usage = rateLimits[provider]
  return {
    usage,
    // Why: a row without a window would repeat the status line.
    usageKnown:
      usage !== null && hasUsageWindow(provider, usage) && !usage.usageMetadata?.unverifiableOwner,
    authConfigured:
      provider === 'grok' ? rateLimits.grokAuthConfigured : rateLimits.cursorAuthConfigured,
    hostFailure: hostState?.failure ?? null,
    hostAnswered: hostState !== null,
    refreshing,
    refreshError,
    refresh: hostKey ? refresh : null
  }
}

function describeServerCliStatus(
  provider: ServerCliProvider,
  label: string,
  usage: ProviderRateLimits | null,
  host: {
    failure: OwnerAccountsFailure | null
    answered: boolean
    authConfigured: boolean
  },
  t: Translate
): { title: string; body: string | null; signedIn: boolean } {
  const grok = provider === 'grok'
  const checking = {
    title: t(
      'auto.components.settings.ServerCliUsageStatus.checkingOn',
      'Checking usage on {{host}}…',
      { host: label }
    ),
    body: null,
    signedIn: false
  }
  // Why: a lost host outranks whatever it last said about this provider.
  if (host.failure) {
    return { title: describeUnverifiableOwner(label, host.failure, t), body: null, signedIn: false }
  }
  if (!usage) {
    if (!host.answered) {
      return checking
    }
    return {
      title: grok
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
    return checking
  }
  if (usage.status === 'ok') {
    return {
      title: t(
        'auto.components.settings.ServerCliUsageStatus.signedInOn',
        'Signed in on {{host}}',
        { host: label }
      ),
      body: grok
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
  const hint = grok
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
  // Why: the host's own wording says "this computer", which reads as this desktop under a server header.
  if (usage.status === 'unavailable') {
    if (host.authConfigured) {
      return {
        title: grok
          ? t(
              'auto.components.settings.ServerCliUsageStatus.reportedNoGrok',
              '{{host}} reported no Grok usage',
              { host: label }
            )
          : t(
              'auto.components.settings.ServerCliUsageStatus.reportedNoCursor',
              '{{host}} reported no Cursor usage',
              { host: label }
            ),
        body: null,
        signedIn: false
      }
    }
    return {
      title: grok
        ? t(
            'auto.components.settings.ServerCliUsageStatus.noSignInGrok',
            'No Grok sign-in on {{host}}',
            { host: label }
          )
        : t(
            'auto.components.settings.ServerCliUsageStatus.noSignInCursor',
            'No Cursor sign-in on {{host}}',
            { host: label }
          ),
      body: hint,
      signedIn: false
    }
  }
  const failureKind = usage.usageMetadata?.failureKind
  return {
    title: getProviderUsageStatusLabel(usage, t),
    // Why: unverifiableOwner text is our own copy naming the host; any other error text is the host's.
    body: usage.usageMetadata?.unverifiableOwner
      ? usage.error
      : failureKind !== undefined && FIX_BY_SIGN_IN_FAILURES.has(failureKind)
        ? hint
        : null,
    signedIn: false
  }
}

export function ServerCliUsageRow({
  provider,
  label,
  usage,
  host,
  refreshing,
  refreshError,
  onRefresh
}: {
  provider: ServerCliProvider
  label: string
  usage: ProviderRateLimits | null
  host: { failure: OwnerAccountsFailure | null; answered: boolean; authConfigured: boolean }
  refreshing: boolean
  refreshError: string | null
  onRefresh: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const { title, body, signedIn } = describeServerCliStatus(provider, label, usage, host, t)

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
        {refreshError ? <p className="text-xs text-destructive">{refreshError}</p> : null}
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
