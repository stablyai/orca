import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import {
  callAntigravityAccounts,
  selectAntigravityAccount
} from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { useDetectedAgents } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import { useAppStore } from '@/store/index'
import {
  handleRunningAntigravityTerminalsAfterSelect,
  readAntigravityRunningSessionsPolicy
} from '@/lib/provider-accounts/antigravity-account-switch-sessions'
import { antigravityAccountSwitchCopy } from '@/lib/provider-accounts/account-switch-copy'
import { RunningSessionSwitchSetting } from '../running-session-switch-setting'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
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
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'
import {
  AntigravityAgyAccountRows,
  type AntigravityAccountAction
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
  const runningSessionsPolicy = useAppStore(
    (s) => s.settings?.antigravityAccountSwitchRunningSessions
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [state, setState] = useState<AntigravityAccountState | null>(null)
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

  /** `keepShown`: a background re-read, which leaves an error on screen. */
  async function perform(
    action: AntigravityAccountAction,
    accountId: string | undefined,
    keepShown: boolean
  ) {
    if (!keepShown) {
      setError(null)
    }
    try {
      if (action === 'Select' && accountId) {
        const previous = state
        const next = await selectAntigravityAccount(
          owner,
          target,
          accountId,
          readAntigravityRunningSessionsPolicy()
        )
        if (mounted.current) {
          setState(next)
        }
        if (
          handleRunningAntigravityTerminalsAfterSelect({
            owner,
            target,
            previous,
            next,
            accountId
          }) !== 'handled'
        ) {
          announceAntigravityAccountSwitch(next, accountId, target.runtime === 'host')
        }
        return
      }
      const next = await callAntigravityAccounts(owner, target, action, accountId)
      if (mounted.current) {
        setState(next)
      }
    } catch (cause) {
      if (action === 'Select') {
        announceAntigravityAccountSwitchFailure(cause)
      }
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
      // A background re-read fails quietly, and a failed switch says why in its toast.
      if (mounted.current && !keepShown && action !== 'Select') {
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
  // A pick moves new chats between agy's own home and Orca's, which the description follows.
  const reread = () => void run('List', undefined, true)
  // Signing in or adding an account changes agy's login, which the account rows read again.
  // 'idle' once the status is read is a first value, so the first sign-in after mount re-reads too.
  const signedInFlow = !signIn.known
    ? null
    : signIn.flow?.phase === 'signedIn'
      ? (signIn.flow.flowId ?? 'another client')
      : 'idle'
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
        {/* A server's own setting applies there; this window passes its choice along. */}
        {owner.kind === 'local' && runtime === 'host' ? (
          <RunningSessionSwitchSetting
            copy={antigravityAccountSwitchCopy(t)}
            value={runningSessionsPolicy}
            onChange={(value) => updateSettings({ antigravityAccountSwitchRunningSessions: value })}
          />
        ) : null}
      </SettingsGroup>
      {chats && !chatsHere ? (
        <ChatUnavailableOnWindowsNote label={t('accounts.antigravity.title', 'Antigravity')} />
      ) : null}
    </div>
  )
}
