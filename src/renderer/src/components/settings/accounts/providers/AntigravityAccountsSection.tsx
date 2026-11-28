import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { callAntigravityAccounts } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { useDetectedAgents } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { clearAntigravityChatSignInError } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { AntigravityChatAuthRows } from '../../../provider-accounts/AntigravityChatAuthRows'
import { useAntigravityChatSignInControls } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { ChatUnavailableOnWindowsNote } from '../../../agent/launch-settings/AgentChatChoiceControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../../shared/agent-session/capabilities/structured-chat-platform-support'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { useOnLaterChange } from './use-on-later-change'
import { useAntigravityAccountRun } from './use-antigravity-account-run'
import {
  announceAntigravityAccountSwitch,
  announceAntigravityAccountSwitchFailure
} from '@/lib/provider-accounts/antigravity-account-switch-toasts'
import { useAgyLoginChange } from './use-agy-login-change'
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'
import {
  AntigravityAgyAccountRows,
  type AntigravityAccountAction,
  type AntigravityAccountError
} from './AntigravityAgyAccountRows'
import { AntigravityAgyCliRow } from './AntigravityAgyCliRow'

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
  const [error, setError] = useState<AntigravityAccountError | null>(null)
  const mounted = useRef(true)
  // Reads can answer out of order (the mount read and a login-change re-read); the newest wins.
  const reads = useRef({ issued: 0, applied: 0 })
  const { busy, run } = useAntigravityAccountRun(perform, mounted)
  const ownerKind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const windowsHost = ownerPlatform === 'win32' && target.runtime === 'host'
  const runtime = target.runtime
  const wslDistro = target.wslDistro ?? null
  // Chats run on the host itself, never in a WSL distro.
  const chats = runtime !== 'wsl'
  const chatsHere = chats && !structuredChatUnavailableOnPlatform('antigravity', ownerPlatform)
  // The host finds agy as its chats do; an older host doesn't say, so its agent list answers.
  const hostSays = state === null || state.agyInstalled !== undefined
  const agents = useDetectedAgents(
    !chats || hostSays
      ? undefined
      : environmentId
        ? { kind: 'runtime', environmentId }
        : { kind: 'local' },
    'all'
  )
  // The user installs agy; signing it in runs it, so that waits until the host finds it.
  const agyInstalled = !chats
    ? null
    : hostSays
      ? (state?.agyInstalled ?? null)
      : (agents.detectedIds?.includes('antigravity') ?? null)
  const signIn = useAntigravityChatSignInControls({
    owner,
    label,
    disabled: !chatsHere || agyInstalled !== true
  })
  const signInControls = chatsHere && agyInstalled === true ? signIn : undefined

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const currentOwner: RuntimeClientTarget =
      ownerKind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    const read = ++reads.current.issued
    void callAntigravityAccounts(currentOwner, { runtime, wslDistro }, 'List').then(
      (next) => {
        if (!cancelled && read > reads.current.applied) {
          reads.current.applied = read
          setState(next)
        }
      },
      (cause: unknown) => {
        // A newer read already showed the accounts; this older failure describes nothing on screen.
        if (!cancelled && read > reads.current.applied) {
          setError({
            message:
              cause instanceof Error ? cause.message : 'Antigravity accounts could not be loaded.',
            accountId: null
          })
        }
      }
    )
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [ownerKind, environmentId, runtime, wslDistro])

  /** `keepShown`: a background re-read, which leaves an error on screen. */
  async function perform(
    action: AntigravityAccountAction,
    accountId: string | undefined,
    keepShown: boolean
  ) {
    if (!keepShown) {
      setError(null)
    }
    const apply = (read: number, next: AntigravityAccountState | null) => {
      if (mounted.current && read > reads.current.applied) {
        reads.current.applied = read
        setState(next)
      }
    }
    const read = ++reads.current.issued
    try {
      const next = await callAntigravityAccounts(owner, target, action, accountId)
      apply(read, next)
      if (action === 'Select' && accountId) {
        announceAntigravityAccountSwitch(next, accountId, target.runtime === 'host')
      }
    } catch (cause) {
      if (action === 'Select') {
        announceAntigravityAccountSwitchFailure(cause)
      }
      if (action === 'Select' || action === 'Remove' || action === 'AddCurrent') {
        const reread = ++reads.current.issued
        try {
          apply(reread, await callAntigravityAccounts(owner, target, 'List'))
        } catch {
          apply(reread, null)
        }
      }
      // A background re-read fails quietly, and a failed switch says why in its toast.
      if (mounted.current && !keepShown && action !== 'Select') {
        setError({
          message: cause instanceof Error ? cause.message : 'Antigravity account action failed.',
          accountId: accountId ?? null
        })
      }
    }
  }

  const logoTitle = (title: string) => (
    <span className="flex items-center gap-2">
      <AgentIcon agent="antigravity" size={16} />
      {title}
    </span>
  )
  // A pick moves new chats between agy's own home and Orca's, which the description follows.
  const reread = () => void run('List', undefined, true)
  // Every sign-in that ends changes what the rows show: agy's new login, or, when cancelled or
  // failed, its current one saved before the sign-in began. 'idle' once the status is read is a
  // first value, so the first sign-in after mount re-reads too.
  const flow = signIn.flow
  const flowEnded = flow !== null && !signIn.signingIn
  const endedFlow = !signIn.known
    ? null
    : flowEnded
      ? `${flow.flowId ?? 'another client'}:${flow.phase}`
      : 'idle'
  // agy's login on the host doesn't change a WSL distro's.
  const shown = useAgyLoginChange(owner, chats, state, reread, () => {
    setError(null)
    // The sign-in store follows the host's agy, which a WSL distro's login doesn't change.
    if (chats) {
      clearAntigravityChatSignInError(owner)
    }
  })
  // A sign-in signs in the host's agy, not a WSL distro's; a hidden window reads once shown again.
  useOnLaterChange(chats && shown ? endedFlow : null, reread)
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
        {chatsHere ? <AntigravityChatAuthRows owner={owner} onSaved={reread} /> : null}
        <AntigravityAgyAccountRows
          state={state}
          error={error}
          busy={busy}
          windowsHost={windowsHost}
          run={(action, accountId) => void run(action, accountId)}
          {...(signInControls ? { signIn: signInControls } : {})}
        />
        {chats ? (
          <AntigravityAgyCliRow
            owner={owner}
            installed={agyInstalled}
            checking={busy || agents.isRefreshing}
            onCheckAgain={() => {
              // An older host answers from its agent list, which a re-list alone doesn't refresh.
              if (!hostSays) {
                void agents.refresh()
              }
              void run('List')
            }}
          />
        ) : null}
      </SettingsGroup>
      {chats && !chatsHere ? (
        <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
      ) : null}
    </div>
  )
}
