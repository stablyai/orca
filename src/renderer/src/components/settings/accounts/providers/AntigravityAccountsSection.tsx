import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { callAntigravityAccounts } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { localAccountRuntimeTargetKey } from '../../../../../../shared/agent-accounts/local-account-runtime'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { ManagedRuntimeInstallRow } from '../../../managed-runtime/ManagedRuntimeInstallRow'
import { antigravityChatSignInRunning } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { AntigravityChatAuthRows } from '../../../provider-accounts/AntigravityChatAuthRows'
import { antigravityChatSignInBlocked } from '../../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatSignInControls } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/capabilities/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { useOnLaterChange } from './use-on-later-change'
import { useAntigravityAccountRun } from './use-antigravity-account-run'
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'
import {
  AntigravityAgyAccountRows,
  type AntigravityAccountAction
} from './AntigravityAgyAccountRows'

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

// Why a helper: React Compiler cannot compile a throw statement inside try/catch.
function staleUsageRead(message: string): never {
  throw new Error(message)
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
  const mounted = useRef(true)
  const { busy, run } = useAntigravityAccountRun(perform, mounted)
  const ownerKind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const windowsHost = ownerPlatform === 'win32' && target.runtime === 'host'
  const runtime = target.runtime
  const wslDistro = target.wslDistro ?? null
  // Chats run on the host itself, never in a WSL distro.
  const chats = runtime !== 'wsl'
  const chatRuntime = useManagedRuntimeInstall(owner, 'antigravity', chats)
  // Install and Remove wait for a sign-in, which runs agy.
  const chatSignIn = chats && chatRuntime.kind === 'active'
  // Signing agy in runs on this host, never in a WSL distro, and needs agy installed.
  const signIn = useAntigravityChatSignInControls({
    owner,
    label,
    disabled: chatRuntime.kind !== 'active' || !chats || antigravityChatSignInBlocked(chatRuntime)
  })
  const signInControls = chatSignIn ? signIn : undefined

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

  /** `keepShown`: a background re-read, which leaves a Usage reading or error on screen. */
  async function perform(
    action: AntigravityAccountAction,
    accountId: string | undefined,
    keepShown: boolean
  ) {
    if (!keepShown) {
      setError(null)
      setUsage(null)
    }
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
          staleUsageRead('The native account changed while reading usage. Refresh usage again.')
        }
        const usage = snapshot.rateLimits.antigravity
        const provenance = usage?.usageMetadata?.authProvenance
        // Usage follows the Accounts location; a reading from another runtime is another login's.
        if (provenance && !usageMatchesTarget(provenance, target)) {
          staleUsageRead(
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
      // A background re-read fails quietly; the next one or Refresh shows the answer.
      if (mounted.current && !keepShown) {
        setError(cause instanceof Error ? cause.message : 'Antigravity account action failed.')
      }
    }
  }

  const logoTitle = (title: string) => (
    <span className="flex items-center gap-2">
      <AgentIcon agent="antigravity" size={16} />
      {title}
    </span>
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
              <p className="text-sm font-medium">{t('accounts.antigravity.runtime', 'Runtime')}</p>
              <div className="mt-0.5">{line}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          </div>
        )}
      </ManagedRuntimeInstallRow>
    ) : null

  // A pick moves new chats between agy's own home and Orca's, which the description follows.
  const reread = () => void run('List', undefined, true)
  // Installing or removing agy changes what its account rows can read.
  const installKey =
    chatRuntime.kind === 'active' && chatRuntime.snapshot.kind === 'known'
      ? `${chatRuntime.snapshot.state.program}:${chatRuntime.snapshot.state.source}`
      : null
  useOnLaterChange(installKey, reread)
  // Signing in or adding an account changes agy's login, which the account rows read again.
  // 'idle' is a known first value, so the first sign-in after mount re-reads too.
  const signedInFlow =
    signIn.flow?.phase === 'signedIn' ? (signIn.flow.flowId ?? 'another client') : 'idle'
  useOnLaterChange(signedInFlow, reread)
  const description = windowsHost
    ? t(
        'accounts.antigravity.descriptionWindows',
        "Chats and agy in the terminal share agy's Google accounts. Switching applies to the host default agy credential. Chats can sign in with a Gemini API key or gcloud instead."
      )
    : chats
      ? t(
          'accounts.antigravity.description',
          "Chats and agy in the terminal share agy's Google accounts. Chats can sign in with a Gemini API key or gcloud instead."
        )
      : t(
          'accounts.antigravity.terminalDescription',
          "Uses agy's own saved accounts. Switching applies to new agy sessions."
        )

  return (
    <div id={ACCOUNTS_SECTION_IDS.antigravity} className="scroll-mt-6 space-y-6">
      <SettingsGroup
        title={logoTitle(t('accounts.antigravity.title', 'Antigravity'))}
        description={description}
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
        {chats && chatRuntime.kind === 'active' ? (
          <AntigravityChatAuthRows owner={owner} onSaved={reread} />
        ) : null}
        <AntigravityAgyAccountRows
          state={state}
          usage={usage}
          error={error}
          busy={busy}
          windowsHost={windowsHost}
          run={(action, accountId) => void run(action, accountId)}
          {...(signInControls ? { signIn: signInControls } : {})}
        />
        {runtimeRow}
      </SettingsGroup>
      {chats &&
      chatRuntime.kind !== 'active' &&
      structuredChatUnavailableOnPlatform('antigravity', ownerPlatform) ? (
        <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
      ) : null}
    </div>
  )
}
