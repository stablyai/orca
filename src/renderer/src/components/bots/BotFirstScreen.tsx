import { useMemo, useState } from 'react'
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
import type { Bot } from '../../../../shared/bot-types'
import { botSetupSteps } from '../../../../shared/bots/bot-setup-steps'
import type { NativeChatFirstScreen } from '../native-chat/native-chat-bot-kickoff-view'
import { useNativeChatVisualOwner } from '../native-chat/media/visuals/native-chat-visual-owner'
import { useBotForWorkspace } from './bot-workspace'
import { BotAvatar } from './BotAvatar'
import { StepIcon } from '../worktree-creation/WorktreeSetupSteps'
import { NativeChatDetailsDisclosure } from '../native-chat/messages/diagnostics/NativeChatProviderDetails'
import { useStructuredAgentSessionHostExecutionPhase } from '../native-chat/session/status/structured-agent-session-status-hooks'

/** Shown by name; more are counted. */
const NAMES_SHOWN = 3

function namesText(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN
    ? translate('bots.firstScreen.namesMore', '{{names}} and {{count}} more', {
        names: shown,
        count: names.length - NAMES_SHOWN
      })
    : shown
}

function projectsText(row: FirstLookRow): string {
  if (row.state !== 'done') {
    return translate(
      'bots.firstScreen.projectsReading',
      'Projects: looking at what you have in Orca…'
    )
  }
  if (row.count === undefined) {
    return translate('bots.firstScreen.projectsDone', 'Looked at your projects')
  }
  if (row.count === 0) {
    return translate('bots.firstScreen.projectsNone', 'No projects in Orca yet')
  }
  const names = namesText(row.names ?? [])
  return row.count === 1
    ? translate('bots.firstScreen.projectsOne', 'Found 1 project: {{names}}', {
        names
      })
    : translate('bots.firstScreen.projectsMany', 'Found {{count}} projects: {{names}}', {
        count: row.count,
        names
      })
}

function githubText(row: FirstLookRow): string {
  if (row.state !== 'done') {
    return translate('bots.firstScreen.githubReading', 'GitHub: reading your open PRs…')
  }
  if (row.count === undefined) {
    return translate('bots.firstScreen.githubDone', 'GitHub: looked at your work')
  }
  return row.count === 1
    ? translate('bots.firstScreen.githubOne', 'GitHub: 1 open PR of yours')
    : translate('bots.firstScreen.githubMany', 'GitHub: {{count}} open PRs of yours', {
        count: row.count
      })
}

function linearText(row: FirstLookRow): string {
  if (row.state !== 'done') {
    return translate('bots.firstScreen.linearReading', 'Linear: reading your open issues…')
  }
  if (row.count === undefined) {
    return translate('bots.firstScreen.linearDone', 'Linear: looked at your issues')
  }
  if (row.more) {
    return translate(
      'bots.firstScreen.linearMore',
      'Linear: {{count}}+ open issues assigned to you',
      {
        count: row.count
      }
    )
  }
  return row.count === 1
    ? translate('bots.firstScreen.linearOne', 'Linear: 1 open issue assigned to you')
    : translate('bots.firstScreen.linearMany', 'Linear: {{count}} open issues assigned to you', {
        count: row.count
      })
}

function workspacesText(row: FirstLookRow): string {
  if (row.state !== 'done') {
    return translate(
      'bots.firstScreen.workspacesReading',
      'Workspaces: looking at what your agents are doing…'
    )
  }
  if (row.count === undefined) {
    return translate('bots.firstScreen.workspacesDone', 'Looked at your workspaces')
  }
  if (row.count === 0) {
    return translate('bots.firstScreen.workspacesNone', 'No workspaces with an agent open')
  }
  return row.count === 1
    ? translate('bots.firstScreen.workspacesOne', 'Workspaces: 1 with an agent open')
    : translate('bots.firstScreen.workspacesMany', 'Workspaces: {{count}} with an agent open', {
        count: row.count
      })
}

function toolsText(row: FirstLookRow): string {
  if (row.state !== 'done') {
    return translate('bots.firstScreen.toolsReading', 'Your tools: MCP servers…')
  }
  if (row.count === undefined) {
    return translate('bots.firstScreen.toolsDone', 'Looked at your MCP servers')
  }
  if (row.count === 0) {
    return translate('bots.firstScreen.toolsNone', 'No MCP servers yet')
  }
  const names = namesText(row.names ?? [])
  return row.count === 1
    ? translate('bots.firstScreen.toolsOne', '1 MCP server: {{names}}', {
        names
      })
    : translate('bots.firstScreen.toolsMany', '{{count}} MCP servers: {{names}}', {
        count: row.count,
        names
      })
}

const ROW_TEXT = {
  projects: projectsText,
  github: githubText,
  linear: linearText,
  workspaces: workspacesText,
  tools: toolsText
}

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

function TryAgain({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const [asked, setAsked] = useState(false)
  return (
    <div className="mt-1 flex items-center gap-2 border-t border-border pt-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {t('bots.firstScreen.failed', 'Couldn’t finish setting up')}
      </span>
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
  firstScreen
}: {
  bot: Bot
  firstScreen: NativeChatFirstScreen
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
            {step.detail ? (
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
      {failed ? <TryAgain bot={bot} /> : null}
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
      <BotSetupSteps bot={bot} firstScreen={firstScreen} />
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
              <span className="min-w-0 truncate">{ROW_TEXT[row.area](row)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
