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
import { AntigravityChatAuthForm } from '../../../provider-accounts/AntigravityChatAuthForm'
import {
  antigravityChatDescription,
  type AntigravityChatDescription
} from '../../../provider-accounts/antigravity-chat-description'
import type { AntigravityChatAuthConfig } from '../../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/capabilities/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'
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
  const [chatMethod, setChatMethod] = useState<AntigravityChatAuthConfig['method'] | null>(null)
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
  const managedVersion =
    chatRuntime.kind === 'active' &&
    chatRuntime.snapshot.kind === 'known' &&
    chatRuntime.snapshot.state.source === 'managed'
      ? chatRuntime.snapshot.state.installedVersion
      : null

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

  const agyVersion = state?.chatAgyVersion
  const chatDescriptions: Record<AntigravityChatDescription, string> = {
    olderHost: t(
      'accounts.antigravity.chatDescriptionOlderHost',
      'Update Orca on this computer so its chats run on agy.'
    ),
    orcaHome: t(
      'accounts.antigravity.chatDescriptionOrcaHome',
      'Chats run on agy with the key or gcloud login below, apart from agy in the terminal.'
    ),
    installAgy: t(
      'accounts.antigravity.chatDescriptionInstallAgy',
      'Install agy below to use Chat. It signs in with its own account.'
    ),
    agySignedOut: t(
      'accounts.antigravity.chatDescriptionAgySignedOut',
      "New chats use agy, which isn't signed in yet. Run agy on this host to sign in."
    ),
    orcasAgy: managedVersion
      ? t(
          'accounts.antigravity.chatDescriptionOrcaAgyVersion',
          "Chats run on Orca's agy (v{{version}}) and use agy's own sign-in.",
          { version: managedVersion }
        )
      : t(
          'accounts.antigravity.chatDescriptionOrcaAgy',
          "Chats run on Orca's copy of agy and use agy's own sign-in."
        ),
    agy: agyVersion
      ? t(
          'accounts.antigravity.chatDescriptionAgyOwnSignInVersion',
          "Chats run on your agy (v{{version}}) and use agy's own sign-in.",
          { version: agyVersion }
        )
      : t(
          'accounts.antigravity.chatDescriptionAgyOwnSignIn',
          "Chats run on agy and use agy's own sign-in."
        )
  }

  const chatRows =
    chats && chatRuntime.kind === 'active' ? (
      <>
        <AntigravityChatAuthForm owner={owner} disabled={busy} onMethod={setChatMethod} />
        {runtimeRow}
      </>
    ) : null

  return (
    <div id={ACCOUNTS_SECTION_IDS.antigravity} className="scroll-mt-6 space-y-6">
      {chatRows ? (
        <SettingsGroup
          title={logoTitle(t('accounts.antigravity.chatTitle', 'Antigravity Chat'))}
          description={chatDescriptions[antigravityChatDescription(state, chatRuntime, chatMethod)]}
        >
          {chatRows}
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        title={logoTitle(t('accounts.antigravity.terminalTitle', 'agy in the terminal'))}
        description={
          windowsHost
            ? t(
                'accounts.antigravity.terminalDescriptionWindows',
                "Uses agy's own saved accounts. Switching applies to the host default agy credential."
              )
            : state?.chatUsesAgy === undefined && state?.chatAgySignedOut === undefined
              ? t(
                  'accounts.antigravity.terminalDescription',
                  "Uses agy's own saved accounts. Switching applies to new agy sessions."
                )
              : state?.chatUsesAgy || state?.chatAgySignedOut
                ? t(
                    'accounts.antigravity.terminalDescriptionChats',
                    "Uses agy's own saved accounts. Switching applies to new agy sessions and to Antigravity chats."
                  )
                : t(
                    'accounts.antigravity.terminalDescriptionNoChats',
                    "Uses agy's own saved accounts. Switching applies to new agy sessions, not to Antigravity chats."
                  )
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
      </SettingsGroup>
      {chats &&
      chatRuntime.kind !== 'active' &&
      structuredChatUnavailableOnPlatform('antigravity', ownerPlatform) ? (
        <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
      ) : null}
    </div>
  )
}
