import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'

export function AntigravityAccountsSection({
  owner,
  target,
  label
}: {
  owner: RuntimeClientTarget
  target: AntigravityAccountTarget
  label: string
}): React.JSX.Element {
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  const [usageSnapshot, setUsageSnapshot] = useState<{
    subject: string
    authMethod: string
    limits: ProviderRateLimits | null
  } | null>(null)
  const current = state?.currentAccount
  const usage =
    current?.subject === usageSnapshot?.subject && current?.authMethod === usageSnapshot?.authMethod
      ? usageSnapshot?.limits
      : null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const requestGeneration = useRef(0)
  const ownerKind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const runtime = target.runtime
  const wslDistro = target.wslDistro ?? null

  useEffect(() => {
    const generation = ++requestGeneration.current
    setState(null)
    setUsageSnapshot(null)
    setError(null)
    setBusy(false)
    pending.current = false
    const currentOwner: RuntimeClientTarget =
      ownerKind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    void callAntigravityAccounts(currentOwner, { runtime, wslDistro }, 'List').then(
      (next) => {
        if (requestGeneration.current === generation) {
          setState(next)
        }
      },
      (cause: unknown) => {
        if (requestGeneration.current === generation) {
          setError(
            cause instanceof Error ? cause.message : 'Antigravity accounts could not be loaded.'
          )
        }
      }
    )
    return () => {
      requestGeneration.current = generation + 1
    }
  }, [ownerKind, environmentId, runtime, wslDistro])

  async function run(
    action: 'List' | 'AddCurrent' | 'Select' | 'Remove' | 'Usage',
    accountId?: string
  ) {
    if (pending.current) {
      return
    }
    const generation = requestGeneration.current
    const isCurrent = () => requestGeneration.current === generation
    const actionTarget: AntigravityAccountTarget =
      runtime === 'wsl' && action !== 'List' && action !== 'Usage'
        ? { runtime, wslDistro, expectedAuthorityId: state?.resolvedTarget?.authorityId }
        : target
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (action === 'Usage') {
        setUsageSnapshot(null)
        const before = await callAntigravityAccounts(owner, target, 'List')
        if (!isCurrent()) {
          return
        }
        const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState }>(
          owner,
          'accounts.list',
          { refreshUsage: true }
        )
        const after = await callAntigravityAccounts(owner, target, 'List')
        if (isCurrent()) {
          setState(after)
        }
        if (
          !before.currentAccount?.subject ||
          before.currentAccount.subject !== after.currentAccount?.subject ||
          before.currentAccount.authMethod !== after.currentAccount.authMethod
        ) {
          throw new Error('The native account changed while reading usage. Refresh usage again.')
        }
        if (isCurrent()) {
          setUsageSnapshot({
            subject: before.currentAccount.subject,
            authMethod: before.currentAccount.authMethod,
            limits: snapshot.rateLimits.antigravity
          })
        }
      } else {
        if (action === 'Select') {
          setUsageSnapshot(null)
        }
        const next = await callAntigravityAccounts(owner, actionTarget, action, accountId)
        if (isCurrent()) {
          setState(next)
        }
      }
    } catch (cause) {
      if (!isCurrent()) {
        return
      }
      if (action === 'Select' || action === 'Remove' || action === 'AddCurrent') {
        try {
          const observed = await callAntigravityAccounts(owner, target, 'List')
          if (isCurrent()) {
            setState(observed)
          }
        } catch {
          if (isCurrent()) {
            setState(null)
          }
        }
      }
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : 'Antigravity account action failed.')
      }
    } finally {
      if (isCurrent()) {
        pending.current = false
        setBusy(false)
      }
    }
  }

  const unbound = runtime === 'wsl' && !state?.resolvedTarget?.authorityId

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="antigravity" size={16} />
          {translate('accounts.antigravity.title', 'Antigravity')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate('accounts.antigravity.scope', 'Manage the native agy account on {{host}}.', {
            host:
              !wslDistro && state?.resolvedTarget
                ? `${label} (${state.resolvedTarget.wslDistro})`
                : label
          })}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'accounts.antigravity.signIn',
          'Start agy on this host and complete its browser sign-in, then save the current account. To add a different account, use /logout in agy and sign in again.'
        )}{' '}
        <a
          className="underline"
          href="https://antigravity.google/docs/cli/install/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {translate('accounts.antigravity.docs', 'Sign-in instructions')}
        </a>
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!state && error && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('List')}>
          {translate('accounts.antigravity.retry', 'Retry')}
        </Button>
      )}
      {state && (
        <div className="space-y-3">
          <p className="text-xs">
            {state.currentAccount
              ? (state.currentAccount.email ??
                translate('accounts.antigravity.identityUnknown', 'Signed-in identity unavailable'))
              : translate('accounts.antigravity.signedOut', 'No native agy account is signed in.')}
          </p>
          {state.selectedAccountId && state.activeAccountId !== state.selectedAccountId && (
            <p className="text-xs text-destructive">
              {translate(
                'accounts.antigravity.changed',
                'The native account changed. Select a saved account again before launching agy.'
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || unbound || !state.currentAccount?.identityKnown}
              onClick={() => void run('AddCurrent')}
            >
              {translate('accounts.antigravity.save', 'Save current account')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('List')}>
              {translate('accounts.antigravity.refresh', 'Refresh accounts')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !state.currentAccount || target.runtime === 'wsl'}
              onClick={() => void run('Usage')}
            >
              {translate('accounts.antigravity.usage', 'Refresh usage')}
            </Button>
            {busy && (
              <Loader2
                className="size-4 animate-spin"
                aria-label={translate('accounts.antigravity.working', 'Updating account')}
              />
            )}
          </div>
          {usage && (
            <p className="text-xs text-muted-foreground">
              {usage.error ??
                translate(
                  'accounts.antigravity.usageReading',
                  'Session: {{session}} · Weekly: {{weekly}}',
                  {
                    session: usage.session ? `${Math.round(usage.session.usedPercent)}%` : '—',
                    weekly: usage.weekly ? `${Math.round(usage.weekly.usedPercent)}%` : '—'
                  }
                )}
            </p>
          )}
          {state.accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="space-y-1">
                <p className="text-xs font-medium">
                  {account.email ?? translate('accounts.antigravity.saved', 'Saved Google account')}
                </p>
                {state.activeAccountId === account.id && (
                  <Badge variant="secondary">
                    {translate('accounts.antigravity.nativeActive', 'Native account')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || unbound}
                  onClick={() => void run('Select', account.id)}
                >
                  {state.selectedAccountId === account.id && state.activeAccountId === account.id
                    ? translate('accounts.antigravity.selected', 'Selected')
                    : translate('accounts.antigravity.select', 'Select')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={
                    busy ||
                    unbound ||
                    state.activeAccountId === account.id ||
                    state.selectedAccountId === account.id
                  }
                  onClick={() => void run('Remove', account.id)}
                >
                  {translate('accounts.antigravity.remove', 'Remove')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {translate(
          'accounts.antigravity.sessions',
          'Selection applies to new agy sessions on this host. Existing sessions may keep their previous account.'
        )}
      </p>
    </section>
  )
}
