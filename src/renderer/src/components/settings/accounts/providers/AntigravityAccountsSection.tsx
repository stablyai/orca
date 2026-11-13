import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { callAntigravityAccounts } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../../shared/antigravity-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../../../shared/rate-limit-types'
import { localAccountRuntimeTargetKey } from '../../../../../../shared/local-account-runtime'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { ManagedRuntimeInstallRow } from '../../../managed-runtime/ManagedRuntimeInstallRow'
import { antigravityChatSignInRunning } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { AntigravityChatSignInRow } from '../../../provider-accounts/AntigravityChatSignInRow'
import { antigravityChatSignInBlocked } from '../../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatSignIn } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { formatTimeAgo } from '../../../status-bar/tooltip'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'

function formatUsageReading(usage: ProviderRateLimits, t: Translate = translate): string {
  return t('accounts.antigravity.usageReading', 'Session: {{session}} · Weekly: {{weekly}}', {
    session: usage.session ? `${Math.round(usage.session.usedPercent)}%` : '—',
    weekly: usage.weekly ? `${Math.round(usage.weekly.usedPercent)}%` : '—'
  })
}

function usageMatchesTarget(provenance: string, target: AntigravityAccountTarget): boolean {
  if (target.runtime === 'host' || target.wslDistro) {
    return (
      provenance ===
      localAccountRuntimeTargetKey({
        runtime: target.runtime,
        wslDistro: target.wslDistro ?? null
      })
    )
  }
  // The host names the default distro; this client does not know it.
  return provenance.startsWith('wsl:')
}

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
  const t = useTranslate()
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
        const usage = snapshot.rateLimits.antigravity
        const provenance = usage?.usageMetadata?.authProvenance
        // Usage follows the Accounts location; a reading from another runtime is another login's.
        if (provenance && !usageMatchesTarget(provenance, target)) {
          throw new Error(
            'Antigravity usage was read from a different location. Refresh usage again.'
          )
        }
        if (mounted.current) {
          setUsage(usage)
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
    <div id={ACCOUNTS_SECTION_IDS.antigravity} className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="antigravity" size={16} />
            {t('accounts.antigravity.title', 'Antigravity')}
          </span>
        }
      >
        <div className="space-y-4 py-4">
          <p className="text-xs text-muted-foreground">
            {t(
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
              {t('accounts.antigravity.docs', 'Sign-in instructions')}
            </a>
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {!state && error && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('List')}>
              {t('accounts.antigravity.retry', 'Retry')}
            </Button>
          )}
          {state && (
            <div className="space-y-3">
              <p className="text-xs">
                {state.currentAccount
                  ? (state.currentAccount.email ??
                    t('accounts.antigravity.identityUnknown', 'Signed-in identity unavailable'))
                  : t('accounts.antigravity.signedOut', 'No native agy account is signed in.')}
              </p>
              {state.selectedAccountId && state.activeAccountId !== state.selectedAccountId && (
                <p className="text-xs text-destructive">
                  {windowsHost
                    ? t(
                        'accounts.antigravity.windowsChanged',
                        'The host default account changed. Select a saved account to apply it again.'
                      )
                    : t(
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
                  {t('accounts.antigravity.save', 'Save current account')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run('List')}
                >
                  {t('accounts.antigravity.refresh', 'Refresh accounts')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !state.currentAccount}
                  onClick={() => void run('Usage')}
                >
                  {t('accounts.antigravity.usage', 'Refresh usage')}
                </Button>
                {busy && (
                  <Loader2
                    className="size-4 animate-spin"
                    aria-label={t('accounts.antigravity.working', 'Updating account')}
                  />
                )}
              </div>
              {usage && (
                <p className="text-xs text-muted-foreground">
                  {usage.error ?? formatUsageReading(usage, t)}
                </p>
              )}
              {state.accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="space-y-1">
                    <p className="text-xs font-medium">
                      {account.email ?? t('accounts.antigravity.saved', 'Saved Google account')}
                    </p>
                    {account.usage !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {account.usage
                          ? t('accounts.antigravity.lastReading', '{{reading}} · Read {{time}}', {
                              reading: formatUsageReading(account.usage, t),
                              time: formatTimeAgo(account.usage.updatedAt, t)
                            })
                          : t('accounts.antigravity.noReading', 'Usage unknown: not read yet')}
                      </p>
                    )}
                    {state.activeAccountId === account.id && (
                      <Badge variant="secondary">
                        {t('accounts.antigravity.nativeActive', 'Native account')}
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
                      {state.selectedAccountId === account.id &&
                      state.activeAccountId === account.id
                        ? t('accounts.antigravity.selected', 'Selected')
                        : t('accounts.antigravity.select', 'Select')}
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
                      {t('accounts.antigravity.remove', 'Remove')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {windowsHost
              ? t(
                  'accounts.antigravity.windowsSessions',
                  'Select applies and verifies the host default agy credential. Command choices and later account changes are handled by agy. Existing sessions may keep their previous account.'
                )
              : t(
                  'accounts.antigravity.sessions',
                  'Selection applies to new agy sessions on this host. Existing sessions may keep their previous account.'
                )}
          </p>
          {chats && chatRuntime.kind === 'active' ? (
            <AntigravityChatSignInRow
              owner={owner}
              label={label}
              description={t(
                'accounts.antigravity.chatSeparate',
                'Separate from your agy terminal account.'
              )}
              disabled={antigravityChatSignInBlocked(chatRuntime)}
              runtime={
                <ManagedRuntimeInstallRow
                  observation={chatRuntime}
                  agentLabel={t('accounts.antigravity.title', 'Antigravity')}
                  signInRunning={antigravityChatSignInRunning(signIn.flow)}
                  buttonSize="default"
                >
                  {(line, actions) => (
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {t('settings.agents.chatRuntime', 'Chat runtime')}
                        </p>
                        <div className="mt-0.5">{line}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">{actions}</div>
                    </div>
                  )}
                </ManagedRuntimeInstallRow>
              }
            />
          ) : chats && structuredChatUnavailableOnPlatform('antigravity', ownerPlatform) ? (
            <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
          ) : null}
        </div>
      </SettingsGroup>
    </div>
  )
}
