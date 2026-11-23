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
import { AntigravityChatSignInRow } from '../../../provider-accounts/AntigravityChatSignInRow'
import {
  antigravityChatDescription,
  antigravityChatSignInBlocked,
  antigravityProviderSignInShown,
  type AntigravityChatDescription
} from '../../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatSignIn } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/capabilities/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { useRecheckOnce } from './use-recheck-once'
import { useOnLaterChange } from './use-on-later-change'
import { useAntigravityAccountRun } from './use-antigravity-account-run'
import { AntigravityGoogleSignInChoice } from '../../../provider-accounts/AntigravityGoogleSignInChoice'
import { AntigravityAgySignInButton } from '../../../provider-accounts/AntigravityAgySignInButton'
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

const AGY_CHECK_SETTLE_MS = 8_000
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
  const { busy, pending, run } = useAntigravityAccountRun(perform, mounted)
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

  // The rows don't wait for a cold agy check (1.5 s); once it has had time to answer, they read
  // it again, so "isn't signed in" and its Sign in show without Refresh.
  const agyUnanswered =
    chats &&
    state !== null &&
    state.chatUsesAgy === undefined &&
    state.chatAgySignedOut === undefined
  useRecheckOnce(agyUnanswered, AGY_CHECK_SETTLE_MS, () => {
    if (pending.current) {
      return false
    }
    void run('List', undefined, true)
    return true
  })

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

  const agyVersion = state?.chatAgyVersion
  const chatDescriptions: Record<AntigravityChatDescription, string> = {
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
        ),
    installAgy: t(
      'accounts.antigravity.chatDescriptionInstallAgy',
      'Install agy below to use Chat. It signs in with its own account.'
    ),
    agySignedIn: agyVersion
      ? t(
          'accounts.antigravity.chatDescriptionAgyVersion',
          "New chats run on your agy (v{{version}}) and its account below. This sign-in is used when agy isn't.",
          { version: agyVersion }
        )
      : t(
          'accounts.antigravity.chatDescriptionAgy',
          "agy is signed in here, so new chats use agy's account below. This sign-in is used when agy isn't."
        ),
    orcaSignIn:
      managedVersion && state?.chatUsesAgy === false
        ? t(
            'accounts.antigravity.chatDescriptionManagedVersion',
            "New chats run on Orca's copy (v{{version}}), so Chat works without agy installed.",
            { version: managedVersion }
          )
        : t(
            'accounts.antigravity.chatDescription',
            'Signs in through your browser, so Chat works without agy installed.'
          )
  }

  const chatDescription = antigravityChatDescription(state, chatRuntime)
  // A pick moves new chats between agy and Orca's server, which the rows' answer follows.
  const reread = () => void run('List', undefined, true)
  // Removing, installing or switching the runtime moves the route; the rows read it again then.
  const installKey =
    chatRuntime.kind === 'active' && chatRuntime.snapshot.kind === 'known'
      ? `${chatRuntime.snapshot.state.program}:${chatRuntime.snapshot.state.source}`
      : null
  useOnLaterChange(installKey, reread)
  // Present only for the Google account method once the route has answered (see the host's
  // chatGoogleSignInInUse); the choice stays hidden otherwise.
  const inUse = state?.chatGoogleSignInInUse
  const googleSignIn = inUse ? { inUse, changed: reread } : undefined
  // Gemini API key chats run on agy here: the method and key stay editable.
  const keyOnAgy = state?.chatKeyOnAgy === true
  const chatRows =
    chats && chatRuntime.kind === 'active' ? (
      keyOnAgy || antigravityProviderSignInShown(chatRuntime) ? (
        <AntigravityChatSignInRow
          owner={owner}
          label={label}
          disabled={!keyOnAgy && antigravityChatSignInBlocked(chatRuntime)}
          runtime={runtimeRow}
          googleSignIn={googleSignIn}
          onSaved={reread}
          noServerAccount={keyOnAgy}
        />
      ) : (
        // No sign-in form: new chats run on agy, or Orca's server isn't installed or is changing.
        // The choice shows wherever the host says Google-account chats run.
        <>
          {googleSignIn && (
            <AntigravityGoogleSignInChoice owner={owner} {...googleSignIn} standalone />
          )}
          {runtimeRow}
        </>
      )
    ) : null

  return (
    <div id={ACCOUNTS_SECTION_IDS.antigravity} className="scroll-mt-6 space-y-6">
      {chatRows ? (
        <SettingsGroup
          title={logoTitle(t('accounts.antigravity.chatTitle', 'Antigravity Chat'))}
          description={
            keyOnAgy
              ? t(
                  'accounts.antigravity.chatDescriptionKeyOnAgy',
                  'New chats run on agy with the sign-in below, kept apart from agy in the terminal.'
                )
              : chatDescriptions[chatDescription]
          }
          action={
            chatDescription === 'agySignedOut' ? (
              <AntigravityAgySignInButton owner={owner} />
            ) : undefined
          }
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
