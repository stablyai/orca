import { useState } from 'react'
import { cn } from '@/lib/class-names'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentStateDot, type AgentDotState } from '@/components/agent/status/AgentStateDot'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { Button } from '@/components/ui/button'
import { ActivityRowButton } from './ActivityRowButton'
import { useBotRowCardPlacement } from './use-bot-row-card-placement'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { selectOrchestrationWorkerWorkspaceLabel } from '@/lib/orchestration-worker-workspace-label'
import { stopOrchestrationWorker } from '@/lib/stop-orchestration-worker'
import {
  sessionWorkerLook,
  sessionWorkerRestingLabel,
  type SessionWorkerLook
} from '@/lib/orchestration-session-worker-status'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useAppStore } from '@/store'
import { formatNativeChatDuration } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import {
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker
} from '../../../../shared/orchestration-session-workers'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'

export type WorkerActivityRowProps = {
  dispatchId: string
  title: string
  /** Drawn only without a host record; a recorded worker draws Crew's look from its record. */
  dot: AgentDotState | null
  running: boolean
  /** What started it, as a sentence ("Started by your chat"). */
  origin?: string
  /** The chat it is nested under, named in the hover card in place of `origin`. */
  chat?: string
  /** Set by a row that draws its own state, time and line 2 rather than reading a host record. */
  icon?: React.ReactNode
  meta?: React.ReactNode
  /** Line 2; null for none. */
  detail?: React.ReactNode
  agent?: string
  summary?: string
  /** Nested under its chat in the Chats tree: a lighter title, quieter once finished. */
  nested?: { settled: boolean }
  /** Who answers its `ask`: the bot, or the chat that started it. */
  coordinator: string
  workspaceId: string | null
  /** The host's own record, which carries time, agent and result; absent for an older host. */
  worker: OrchestrationSessionWorker | null
  onOpen?: () => void
  /** Offered only where this computer can stop the worker. */
  canStop: boolean
  onStopped?: () => void
}

function Elapsed({
  worker,
  look,
  coordinator
}: {
  worker: OrchestrationSessionWorker
  look: SessionWorkerLook
  coordinator: string
}): React.JSX.Element | null {
  const open = sessionWorkerIsRunning(worker)
  const counting = open && look.group === 'working'
  const now = useNow(1_000, counting)
  if (open && !counting) {
    return <>{sessionWorkerRestingLabel(look, coordinator)}</>
  }
  // An end the host never recorded (the process just exited) has no honest duration.
  const end = counting ? now : worker.settledAt
  return end === null ? null : (
    <>{formatNativeChatDuration(Math.max(0, (end - worker.startedAt) / 1000))}</>
  )
}

function Detail({
  label,
  value,
  wrap
}: {
  label: string
  value: string
  wrap?: boolean
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0', wrap ? 'break-words' : 'truncate')}>{value}</dd>
    </>
  )
}

/** One worker in the Activity panel: status, title, time while it works, workspace; hover for details; Stop while it runs. */
export function WorkerActivityRow(props: WorkerActivityRowProps): React.JSX.Element {
  const t = useTranslate()
  const { worker } = props
  const { stopping, stop } = useWorkerStop(props.dispatchId, props.onStopped)
  const workspace = useAppStore((state) =>
    props.workspaceId ? selectOrchestrationWorkerWorkspaceLabel(state, props.workspaceId) : null
  )
  const look = worker ? sessionWorkerLook(worker) : null
  const placement = useBotRowCardPlacement()
  return (
    <HoverCard openDelay={400} closeDelay={100} {...placement.root}>
      <div
        className={cn(
          'group/worker flex w-full min-w-0 items-start gap-1 rounded-sm hover:bg-accent has-[[data-state=open]]:bg-accent',
          props.nested && 'relative'
        )}
      >
        <HoverCardTrigger asChild {...placement.trigger}>
          <ActivityRowButton
            disabled={!props.onOpen}
            onClick={props.onOpen}
            nested={props.nested}
            icon={
              props.icon ? (
                props.icon
              ) : look?.asksCoordinator ? (
                // The question glyph, quiet: its coordinator owes the answer, not you.
                <AgentQuestionIcon className="size-3 text-muted-foreground" />
              ) : look ? (
                <StatusIndicator status={look.status} />
              ) : props.dot ? (
                <AgentStateDot state={props.dot} />
              ) : null
            }
            title={props.title || t('bots.activity.worker', 'Worker')}
            meta={
              props.meta !== undefined ? (
                props.meta
              ) : worker && look ? (
                <Elapsed worker={worker} look={look} coordinator={props.coordinator} />
              ) : null
            }
            metaClassName={props.meta === undefined ? 'max-w-[60%] truncate' : undefined}
            detail={
              props.detail !== undefined ? (
                props.detail
              ) : (
                <span className="block truncate text-2xs text-muted-foreground">
                  {[
                    worker && sessionWorkerIsRunning(worker) ? worker.progressNote : null,
                    workspace ?? props.origin
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )
            }
          />
        </HoverCardTrigger>
        {props.running && props.canStop ? (
          // Shown on hover, as the row's other actions are; centered on the title's line box.
          <span
            className={cn(
              'mr-1 flex items-center opacity-0 transition-opacity group-hover/worker:opacity-100 focus-within:opacity-100',
              // Nested rows are narrow: Stop covers the time on hover rather than taking width from the title.
              props.nested ? 'absolute top-1.5 right-0 h-4 rounded-sm bg-accent' : 'mt-1.5 h-5'
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={t('bots.activity.stopWorker', 'Stop {{value0}}', {
                value0: props.title
              })}
              disabled={stopping}
              onClick={stop}
            >
              {t('bots.activity.stop', 'Stop')}
            </Button>
          </span>
        ) : null}
      </div>
      <HoverCardContent {...placement.content} variant="workspace-details">
        <WorkerActivityDetails
          agent={worker?.agent ?? props.agent}
          progressNote={
            worker && sessionWorkerIsRunning(worker)
              ? (worker.progressNote ?? undefined)
              : undefined
          }
          summary={worker?.summary ?? props.summary}
          chat={props.chat}
          workspaceId={props.workspaceId}
          origin={props.origin}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

/** Stops the worker through its host; `stopping` while the request is out. */
export function useWorkerStop(
  dispatchId: string,
  onStopped?: () => void
): { stopping: boolean; stop: () => void } {
  const [stopping, setStopping] = useState(false)
  const stop = (): void => {
    setStopping(true)
    void stopOrchestrationWorker(dispatchId).finally(() => {
      setStopping(false)
      onStopped?.()
    })
  }
  return { stopping, stop }
}

/** A worker's hover card: its agent, result, chat, workspace and branch; `title` first where the
 *  surface that opened it could not show the whole title. */
export function WorkerActivityDetails({
  title,
  agent: agentId,
  progressNote,
  summary,
  chat,
  workspaceId,
  origin
}: {
  title?: string
  agent?: string
  progressNote?: string
  summary?: string
  chat?: string
  workspaceId: string | null
  origin?: string
}): React.JSX.Element {
  const t = useTranslate()
  const workspace = useAppStore((state) =>
    workspaceId ? selectOrchestrationWorkerWorkspaceLabel(state, workspaceId) : null
  )
  const branch = useAppStore((state) =>
    workspaceId ? (findWorktreeById(state, workspaceId)?.branch ?? null) : null
  )
  const agent = agentId && isTuiAgent(agentId) ? getAgentLabel(agentId) : null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {title ? <dd className="col-span-2 break-words font-medium">{title}</dd> : null}
      {agent ? <Detail label={t('bots.activity.agent', 'Agent')} value={agent} /> : null}
      {progressNote ? (
        <Detail label={t('bots.activity.progress', 'Progress')} value={progressNote} wrap />
      ) : null}
      {summary ? <Detail label={t('bots.activity.result', 'Result')} value={summary} /> : null}
      {chat ? <Detail label={t('bots.activity.chat', 'Chat')} value={chat} /> : null}
      {workspace ? (
        <Detail label={t('bots.activity.workspace', 'Workspace')} value={workspace} />
      ) : null}
      {branch ? <Detail label={t('bots.activity.branch', 'Branch')} value={branch} /> : null}
      {origin && !chat ? (
        <dd className="col-span-2 truncate text-muted-foreground">{origin}</dd>
      ) : null}
    </dl>
  )
}
