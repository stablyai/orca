import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { ManagedRuntimeInstallRow } from '../../../managed-runtime/ManagedRuntimeInstallRow'
import { antigravityChatSignInRunning } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { AntigravityChatSignInRow } from '../../../provider-accounts/AntigravityChatSignInRow'
import { AntigravityInfoTooltip } from '../../../provider-accounts/AntigravityInfoTooltip'
import {
  antigravityChatSignInBlocked,
  antigravityProviderSignInShown
} from '../../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatSignIn } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  AntigravityTerminalAccountRows,
  type AntigravityAccountAction
} from './AntigravityTerminalAccountRows'

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

  async function run(action: AntigravityAccountAction, accountId?: string) {
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

  const terminalInfo = windowsHost
    ? t(
        'accounts.antigravity.terminalInfoWindows',
        'Run agy to sign in, then save the login here. To add another account, run /logout in agy and sign in again. Selecting applies to the host default agy credential.'
      )
    : t(
        'accounts.antigravity.terminalInfo',
        'Run agy to sign in, then save the login here. To add another account, run /logout in agy and sign in again. Applies to new agy sessions.'
      )
  const runtimeRow =
    chats && chatRuntime.kind === 'active' ? (
      <ManagedRuntimeInstallRow
        observation={chatRuntime}
        agentLabel={t('accounts.antigravity.title', 'Antigravity')}
        signInRunning={antigravityChatSignInRunning(signIn.flow)}
      >
        {(line, actions) => (
          <div data-settings-row="" className="flex items-center justify-between gap-4 py-3">
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
    ) : null

  return (
    <div id="accounts-antigravity" className="scroll-mt-6 space-y-3">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="antigravity" size={16} />
            {t('accounts.antigravity.title', 'Antigravity')}
            <AntigravityInfoTooltip info={terminalInfo} />
          </span>
        }
        action={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('accounts.antigravity.refresh', 'Refresh accounts')}
                disabled={busy}
                onClick={() => void run('List')}
              >
                {busy ? (
                  <Loader2 className="animate-spin text-muted-foreground" />
                ) : (
                  <RefreshCw className="text-muted-foreground" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t('accounts.antigravity.refresh', 'Refresh accounts')}
            </TooltipContent>
          </Tooltip>
        }
      >
        <AntigravityTerminalAccountRows
          state={state}
          usage={usage}
          error={error}
          busy={busy}
          windowsHost={windowsHost}
          run={(action, accountId) => void run(action, accountId)}
        />
        {chats && chatRuntime.kind === 'active' ? (
          antigravityProviderSignInShown(chatRuntime) ? (
            <AntigravityChatSignInRow
              owner={owner}
              label={label}
              disabled={antigravityChatSignInBlocked(chatRuntime)}
              runtime={runtimeRow}
            />
          ) : (
            runtimeRow
          )
        ) : null}
      </SettingsGroup>
      {chats &&
      chatRuntime.kind !== 'active' &&
      structuredChatUnavailableOnPlatform('antigravity', ownerPlatform) ? (
        <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
      ) : null}
    </div>
  )
}
