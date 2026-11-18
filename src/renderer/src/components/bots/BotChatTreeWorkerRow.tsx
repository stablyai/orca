// One worker under its chat in the Chats tab, one line; or a search's worker hit, its chat on line 2.
import { CircleX } from 'lucide-react'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { botTarget } from '@/lib/bot-hosts'
import { openOrchestrationWorker, revealWorkerPane } from '@/lib/open-orchestration-worker'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { formatNativeChatDuration } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { openBotAutomation } from './bot-automation-open'
import { useBotHostLabel } from './use-bot-host-label'
import { WorkerActivityRow } from './WorkerActivityRow'

export function WorkerStateIcon({
  state
}: {
  state: BotChatTreeWorker['state']
}): React.JSX.Element {
  switch (state) {
    case 'running':
      return <StatusIndicator status="working" showTooltip={false} />
    case 'needs-you':
      return <span className="block size-[7px] rounded-full bg-agent-question" />
    case 'asking-bot':
      // Still and dashed, so it never reads as a chat waiting on you.
      return (
        <span className="block size-2.5 rounded-full border-[1.5px] border-dashed border-agent-working opacity-85" />
      )
    case 'unreachable':
      return <AgentStateDot state="unverifiable" size="md" title={null} />
    case 'done':
      return <AgentStateDot state="done" size="md" title={null} />
    case 'failed':
      return <CircleX className="size-3 text-destructive" aria-hidden />
  }
}

function Elapsed({ worker }: { worker: BotChatTreeWorker }): React.JSX.Element | null {
  const counting = worker.state === 'running'
  const now = useNow(1_000, counting)
  const end = counting ? now : worker.settledAt
  return end === undefined ? null : (
    <>{formatNativeChatDuration(Math.max(0, (end - worker.startedAt) / 1000))}</>
  )
}

function noteLabel(t: Translate, note: BotChatTreeWorker['note']): string | null {
  switch (note) {
    case 'handed-over':
      return t('bots.chats.handedOver', 'Handed over')
    case 'from-closed-chat':
      return t('bots.chats.fromClosedChat', 'From closed chat')
    case 'automation-terminal':
      return t('bots.chats.automationTerminal', 'Automation run · terminal')
    case undefined:
      return null
  }
}

function Meta({
  bot,
  worker,
  host
}: {
  bot: Bot
  worker: BotChatTreeWorker
  /** The paired server it runs on, by name; null on the bot's own host. */
  host: string | null
}): React.JSX.Element {
  const t = useTranslate()
  if (worker.state === 'unreachable') {
    return (
      <>
        {host
          ? t('bots.chats.cantReachHost', "Can't reach {{host}}", { host })
          : t('bots.chats.statusUnknown', 'Status unknown')}
      </>
    )
  }
  if (worker.state === 'needs-you') {
    return <span className="text-agent-question-text">{t('bots.chats.needsYou', 'Needs you')}</span>
  }
  if (worker.state === 'asking-bot') {
    return (
      <>
        <span className="@max-[240px]:hidden">
          {t('bots.chats.askingBot', 'Asking {{name}}', { name: bot.name })}
        </span>
        <span className="hidden @max-[240px]:inline">{t('bots.chats.asking', 'Asking')}</span>
      </>
    )
  }
  return <Elapsed worker={worker} />
}

/** Still open: it can be stopped, and its row stays bright. */
export function botChatTreeWorkerRunning(worker: BotChatTreeWorker): boolean {
  return (
    worker.state === 'running' ||
    worker.state === 'needs-you' ||
    worker.state === 'asking-bot' ||
    worker.state === 'unreachable'
  )
}

/** What a click on the worker opens: its automation run, its session, or its pane; nothing to open
 *  when it has none of them. */
export function botChatTreeWorkerOpen(
  bot: Bot,
  worker: BotChatTreeWorker
): (() => void) | undefined {
  const { run, dispatchId, worktreeId } = worker
  if (run) {
    return () => openBotAutomation(run.automationId, run.runId)
  }
  if (dispatchId) {
    return () =>
      openOrchestrationWorker(
        {
          dispatchId,
          title: worker.title,
          worktreeId: worktreeId ?? null,
          chatSessionId: null
        },
        botTarget(bot)
      )
  }
  if (worktreeId) {
    const parsedHost = parseExecutionHostId(worker.hostId)
    const hostId = parsedHost?.kind === 'runtime' ? parsedHost.id : undefined
    return () => revealWorkerPane(worktreeId, worker.paneKey ?? null, hostId)
  }
  return undefined
}

export function BotChatTreeWorkerRow({
  bot,
  worker,
  chat,
  showChat = false
}: {
  bot: Bot
  worker: BotChatTreeWorker
  /** The parent chat as the hover card names it. */
  chat: string
  /** Listed apart from its chat, so a second line names it. */
  showChat?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const parsedHost = parseExecutionHostId(worker.hostId)
  const hostId = parsedHost?.kind === 'runtime' ? parsedHost.id : undefined
  const host = useBotHostLabel(hostId ?? LOCAL_EXECUTION_HOST_ID)
  const worktreeBranch = useAppStore((state) =>
    worker.worktreeId ? (findWorktreeById(state, worker.worktreeId)?.branch ?? null) : null
  )
  // The chat, a note or host comes first, so it survives truncation.
  const line2 = [
    showChat ? chat : null,
    noteLabel(t, worker.note),
    host ? t('bots.chats.onHost', 'on {{host}}', { host }) : null,
    worker.branch ?? worktreeBranch
  ]
    .filter(Boolean)
    .join(' · ')
  const { dispatchId, worktreeId } = worker
  const onOpen = botChatTreeWorkerOpen(bot, worker)
  const running = botChatTreeWorkerRunning(worker)
  return (
    <WorkerActivityRow
      dispatchId={dispatchId ?? ''}
      title={worker.title}
      dot={null}
      running={running}
      chat={chat}
      coordinator={bot.name}
      workspaceId={worktreeId ?? null}
      worker={null}
      canStop={running && Boolean(dispatchId)}
      agent={worker.agent}
      summary={worker.summary}
      nested={{ settled: !running }}
      icon={<WorkerStateIcon state={worker.state} />}
      meta={<Meta bot={bot} worker={worker} host={host} />}
      detail={
        showChat ? (
          <span className="block truncate text-2xs text-muted-foreground">{line2}</span>
        ) : null
      }
      onOpen={onOpen}
    />
  )
}
