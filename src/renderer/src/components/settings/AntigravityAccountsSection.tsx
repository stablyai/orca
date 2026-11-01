import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useManagedRuntimeInstall } from '@/runtime/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../shared/antigravity-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { ManagedRuntimeInstallRow } from '../managed-runtime/ManagedRuntimeInstallRow'
import { antigravityChatSignInRunning } from '@/runtime/antigravity-chat-sign-in-status'
import {
  AntigravityChatSignInRow,
  antigravityChatSignInBlocked,
  useAntigravityChatSignIn
} from './AntigravityChatSignInRow'
import { openAppHttpLinkFromAnchor } from '@/lib/app-http-link-open'

export function AntigravityAccountsSection({
  owner,
  target,
  label,
  ownerPlatform
}: {
  owner: RuntimeClientTarget
  target: AntigravityAccountTarget
  label: string
  ownerPlatform?: string | null
}): React.JSX.Element {
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  const [usage, setUsage] = useState<ProviderRateLimits | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const ownerKind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const windowsHost = ownerPlatform === 'win32' && target.runtime === 'host'
  const runtime = target.runtime
  const wslDistro = target.wslDistro ?? null
  // Chats run on the host itself, never in a WSL distro.
  const chats = runtime !== 'wsl'
  const chatRuntime = useManagedRuntimeInstall(owner, 'antigravity', chats)
  // A remote host's sign-in finishes from the address pasted back into its row.
  const chatSignIn = chats && chatRuntime.kind === 'active'
  const signIn = useAntigravityChatSignIn(chatSignIn ? owner : null)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const currentOwner: RuntimeClientTarget =
      ownerKind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    void callAntigravityAccounts(currentOwner, { runtime, wslDistro }, 'List').then(
      (next) => {
        if (!cancelled) {
          setState(next)
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : 'Antigravity accounts could not be loaded.'
          )
        }
      }
    )
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [ownerKind, environmentId, runtime, wslDistro])

  async function run(
    action: 'List' | 'AddCurrent' | 'Select' | 'Remove' | 'Usage',
    accountId?: string
  ) {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    setError(null)
    setUsage(null)
    try {
      if (action === 'Usage') {
        const before = await callAntigravityAccounts(owner, target, 'List')
        const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState }>(
          owner,
          'accounts.list',
          { refreshUsage: true }
        )
        const after = await callAntigravityAccounts(owner, target, 'List')
        if (mounted.current) {
          setState(after)
        }
        const account = before.currentAccount
        // Native credentials may expose no subject, making two unidentified logins indistinguishable.
        if (
          !account ||
          !after.currentAccount ||
          account.subject !== after.currentAccount.subject ||
          account.authMethod !== after.currentAccount.authMethod
        ) {
          throw new Error('The native account changed while reading usage. Refresh usage again.')
        }
        if (mounted.current) {
          setUsage(snapshot.rateLimits.antigravity)
        }
      } else {
        const next = await callAntigravityAccounts(owner, target, action, accountId)
        if (mounted.current) {
          setState(next)
        }
      }
    } catch (cause) {
      if (action === 'Select' || action === 'Remove' || action === 'AddCurrent') {
        try {
          const observed = await callAntigravityAccounts(owner, target, 'List')
          if (mounted.current) {
            setState(observed)
          }
        } catch {
          if (mounted.current) {
            setState(null)
          }
        }
      }
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Antigravity account action failed.')
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="antigravity" size={16} />
          {translate('accounts.antigravity.title', 'Antigravity')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate('accounts.antigravity.scope', 'Manage the native agy account on {{host}}.', {
            host: label
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
          onClick={openAppHttpLinkFromAnchor}
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
              {windowsHost
                ? translate(
                    'accounts.antigravity.windowsChanged',
                    'The host default account changed. Select a saved account to apply it again.'
                  )
                : translate(
                    'accounts.antigravity.changed',
                    'The native account changed. Select a saved account again before launching agy.'
                  )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !state.currentAccount}
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
                  disabled={busy}
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
        {windowsHost
          ? translate(
              'accounts.antigravity.windowsSessions',
              'Select applies and verifies the host default agy credential. Command choices and later account changes are handled by agy. Existing sessions may keep their previous account.'
            )
          : translate(
              'accounts.antigravity.sessions',
              'Selection applies to new agy sessions on this host. Existing sessions may keep their previous account.'
            )}
      </p>
      {chats && chatRuntime.kind === 'active' ? (
        <div className="space-y-4">
          <ManagedRuntimeInstallRow
            observation={chatRuntime}
            agentLabel={translate('accounts.antigravity.title', 'Antigravity')}
            signInRunning={antigravityChatSignInRunning(signIn.flow)}
          >
            {(line, actions) => (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'settings.chat.providers.antigravityDescription',
                      'Antigravity chats run a server Orca downloads to this host, separate from the agy CLI.'
                    )}
                  </p>
                  {line}
                </div>
                {actions}
              </div>
            )}
          </ManagedRuntimeInstallRow>
          <AntigravityChatSignInRow
            owner={owner}
            label={label}
            description={translate(
              'accounts.antigravity.chatDescription',
              'Chats use their own Antigravity sign-in, separate from your agy account above. Sign in once on this device.'
            )}
            disabled={antigravityChatSignInBlocked(chatRuntime)}
          />
        </div>
      ) : null}
    </section>
  )
}
