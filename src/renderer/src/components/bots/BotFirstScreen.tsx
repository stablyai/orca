import { useCallback, useMemo, useState } from 'react'
import { Check, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { botTarget } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { firstLookRows, type FirstLookRow } from '../../../../shared/bots/bot-first-look'
import { firstLookRowText } from '../../../../shared/bots/bot-first-look-words'
import type { Bot } from '../../../../shared/bot-types'
import { botSetupSteps } from '../../../../shared/bots/bot-setup-steps'
import {
  nativeChatFirstScreenSignIn,
  type NativeChatFirstScreen
} from '../../../../shared/bots/bot-first-screen'
import { useNativeChatHostSetupView } from '../native-chat/host-access/native-chat-host-setup'
import {
  nativeChatSignInNoticeView,
  type NativeChatSignInNoticeView
} from '../native-chat/host-access/native-chat-sign-in-notice'
import { useNativeChatVisualOwner } from '../native-chat/media/visuals/native-chat-visual-owner'
import { useBotForWorkspace } from './bot-workspace'
import { BotAvatar } from './BotAvatar'
import { StepIcon } from '../worktree-creation/WorktreeSetupSteps'
import { NativeChatDetailsDisclosure } from '../native-chat/messages/diagnostics/NativeChatProviderDetails'
import { openAgentSettingsAction } from '../settings/navigation/open-agent-settings'
import { useStructuredAgentSessionHostExecutionPhase } from '../native-chat/session/status/structured-agent-session-status-hooks'
import { NativeChatInstallStrip } from '../native-chat/host-access/NativeChatInstallStrip'
import { NativeChatSignInStrip } from '../native-chat/host-access/NativeChatSignInStrip'
import { useBotSetupInstall } from './BotSetupInstall'

function RowMark({ state }: { state: FirstLookRow['state'] }): React.JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="size-3.5 text-chat-foreground-faint" />
    case 'running':
      return <LoaderCircle className="size-3.5 animate-spin text-chat-foreground-faint" />
    case 'stopped':
      return <X className="size-3.5 text-chat-foreground-faint" />
  }
}

async function tryAgain(bot: Bot): Promise<void> {
  try {
    await callRuntimeRpc(botTarget(bot), 'bots.kickoff.retry', { botId: bot.id })
  } catch (error) {
    console.error('Failed to retry a bot kickoff:', error)
    toast.error(translate('bots.firstScreen.retryFailed', 'Could not try again. Try in a moment.'))
  }
}

function TryAgain({
  bot,
  commandSetting,
  signIn
}: {
  bot: Bot
  /** The agent's Command setting is why it failed, so its fix is one press away. */
  commandSetting: boolean
  signIn: NativeChatSignInNoticeView | null
}): React.JSX.Element {
  const t = useTranslate()
  const [asked, setAsked] = useState(false)
  const settingsAction = openAgentSettingsAction(botTarget(bot), t)
  const button = signIn?.button ?? null
  return (
    <div className="mt-1 flex items-center gap-2 border-t border-border pt-2">
      {/* An agent whose Sign in opens its CLI says the step to take there. */}
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {signIn?.steps ?? t('bots.firstScreen.failed', 'Couldn’t finish setting up')}
      </span>
      {commandSetting ? (
        <Button variant="outline" size="xs" onClick={settingsAction.onClick}>
          {settingsAction.label}
        </Button>
      ) : null}
      {/* The chat's own Sign in; once it's done, Try again sends the setup again. */}
      {button ? (
        <Button
          size="xs"
          disabled={button.busy}
          title={button.description}
          aria-description={button.description}
          onClick={button.onClick}
        >
          {button.label}
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        disabled={asked}
        onClick={() => {
          setAsked(true)
          void tryAgain(bot).finally(() => setAsked(false))
        }}
      >
        <RotateCcw />
        {t('bots.firstScreen.tryAgain', 'Try again')}
      </Button>
    </div>
  )
}

/** Its setup after it exists, step by step from its first turn's own rows: its agent starting, then
 *  its first message, each with the agent's latest retry or failure line and, once failed, Try again. */
function BotSetupSteps({
  bot,
  firstScreen,
  isVisible
}: {
  bot: Bot
  firstScreen: NativeChatFirstScreen
  isVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const agentReady =
    useStructuredAgentSessionHostExecutionPhase(bot.chatSessionId ?? '', botTarget(bot)) === 'ready'
  const { start, reply } = botSetupSteps({
    turn: firstScreen.turn,
    ended: firstScreen.phase === 'failed',
    agentReady,
    refused: firstScreen.refused
  })
  const agent = botAgentLabel(bot.agent)
  const steps = [
    {
      id: 'create',
      step: { state: 'done' as const },
      label: t('bots.firstScreen.stepCreate', 'Create bot')
    },
    {
      id: 'start',
      step: start,
      label: t(
        'auto.components.worktree.creation.WorktreeSetupSteps.startAgent',
        'Start {{agent}}',
        {
          agent
        }
      )
    },
    { id: 'reply', step: reply, label: t('bots.firstScreen.stepReply', 'First message') }
  ]
  const failed = start.state === 'failed' || reply.state === 'failed'
  const retry = useCallback(() => void tryAgain(bot), [bot])
  const { install, signIn } = useBotSetupInstall(bot, failed && isVisible, retry)
  const setup = useNativeChatHostSetupView()
  const owed = nativeChatFirstScreenSignIn(firstScreen)
  const signInView =
    owed && !install && !signIn
      ? nativeChatSignInNoticeView(
          { kind: 'notSignedIn', agent: bot.agent, account: owed.account, setup },
          t
        )
      : null
  return (
    <div className="mt-6 w-96 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
      <ol className="flex flex-col">
        {steps.map(({ id, step, label }) => (
          <li key={id} className="flex flex-col gap-0.5 py-1">
            <div className="flex items-center gap-2">
              <StepIcon state={step.state} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  step.state === 'pending' && 'text-muted-foreground',
                  step.state === 'failed' && 'text-destructive'
                )}
              >
                {label}
              </span>
            </div>
            {/* Install says what is missing; the host's sentence points at a chat this card covers. */}
            {step.detail && !((install || signIn) && id === 'start') ? (
              <p className="ml-5.5 line-clamp-3 break-words text-xs text-muted-foreground">
                {step.detail}
              </p>
            ) : null}
            {step.providerDetail ? (
              <div className="ml-4">
                <NativeChatDetailsDisclosure
                  summary={t('components.native-chat.notices.details', 'Details')}
                >
                  {step.providerDetail}
                </NativeChatDetailsDisclosure>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {install || signIn ? (
        <div className="mt-1 border-t border-border pt-2 pb-1">
          {install ? (
            <NativeChatInstallStrip slot={install} agentLabel={agent} />
          ) : signIn ? (
            <NativeChatSignInStrip state={signIn} agentLabel={agent} />
          ) : null}
        </div>
      ) : failed ? (
        <TryAgain
          bot={bot}
          commandSetting={firstScreen.refused?.kind === 'agentCommandNotRunnable'}
          signIn={signInView}
        />
      ) : null}
    </div>
  )
}

/** A new bot's Home while its first turn runs: who it is, its setup, and what it finds as it reads. */
export function BotFirstScreen({
  firstScreen,
  isVisible
}: {
  firstScreen: NativeChatFirstScreen
  isVisible: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const bot = useBotForWorkspace(useNativeChatVisualOwner()?.worktreeId ?? null)
  const failed = firstScreen.phase === 'failed'
  const rows = useMemo(() => firstLookRows(firstScreen.turn, failed), [firstScreen.turn, failed])
  if (!bot) {
    return null
  }
  const reading = rows.some((row) => row.state === 'running')
  return (
    <div className="scrollbar-sleek absolute inset-0 flex flex-col items-center justify-center overflow-y-auto px-6 pb-10">
      <BotAvatar
        bot={bot}
        className={cn(
          'size-20 rounded-2xl text-3xl',
          !failed && isVisible && 'animate-pulse motion-reduce:animate-none'
        )}
      />
      <span className="pt-4 text-xl font-semibold text-chat-foreground-strong">{bot.name}</span>
      <span className="pt-1 text-sm text-chat-foreground-faint">
        {t('bots.firstScreen.subtitle', 'Your new bot · runs your {{agent}}', {
          agent: botAgentLabel(bot.agent)
        })}
      </span>
      <BotSetupSteps bot={bot} firstScreen={firstScreen} isVisible={isVisible} />
      {rows.length > 0 ? (
        <div className="flex w-96 max-w-full flex-col gap-2 pt-6">
          <span className="text-xs text-chat-foreground-faint">
            {reading || !failed
              ? t('bots.firstScreen.reading', 'Getting to know your setup…')
              : t('bots.firstScreen.read', 'Getting to know your setup')}
          </span>
          {rows.map((row) => (
            <div key={row.area} className="flex items-center gap-2 text-sm text-chat-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center">
                <RowMark state={row.state} />
              </span>
              <span className="min-w-0 truncate">{firstLookRowText(row, t)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
