import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { OrchestrationCrewRow } from '../../../../../../shared/orchestration/orchestration-crew'
import type { BackgroundRosterTask } from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-roster'
import type { AgentSessionBackgroundTaskRunState } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { useCrewRowLooks, type CrewRowLook } from '../../../orchestration-crew/CrewAgentIcons'
import {
  crewStatusGroup,
  type CrewStatusGroup
} from '../../../orchestration-crew/crew-party-status'
import { CrewStripRow } from '../../../orchestration-crew/CrewStripRow'
import type { NativeChatCrew } from '../../../orchestration-crew/use-native-chat-crew'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

/** Waiting for you, then working, failed and idle. */
const STATUS_RANK: Record<CrewStatusGroup, number> = { needsYou: 0, working: 1, failed: 2, idle: 3 }

function subagentRank(state: AgentSessionBackgroundTaskRunState): number {
  switch (state) {
    case 'waiting':
      return STATUS_RANK.needsYou
    case 'working':
    case 'monitoring':
      return STATUS_RANK.working
    case 'blocked':
      return STATUS_RANK.failed
    case 'done':
    case 'idle':
    case 'unverifiable':
      return STATUS_RANK.idle
  }
}

function runningWorker(row: OrchestrationCrewRow): boolean {
  return Boolean(
    row.sendAddress &&
    row.task &&
    !['completed', 'failed'].includes(row.task.state) &&
    (row.task.state === 'dispatched' || ['working', 'waiting', 'blocked'].includes(row.status))
  )
}

type AgentEntry =
  | { kind: 'worker'; row: OrchestrationCrewRow; rank: number; index: number }
  | { kind: 'subagent'; task: BackgroundRosterTask; rank: number; index: number }

/** The strip's heading style, with a count and an optional control at its end. */
export function StripGroupHeading({
  label,
  count,
  hint,
  action
}: {
  label: string
  count?: number
  /** What the group holds, on hover. */
  hint?: string
  action?: React.ReactNode
}): React.JSX.Element {
  const text = (
    <span>
      {label}
      {count === undefined ? null : <span className="ml-1.5">{count}</span>}
    </span>
  )
  return (
    <div className="flex min-h-5 items-center gap-1.5 px-0.5 pb-1 font-mono text-3xs uppercase tracking-wider text-muted-foreground">
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>{text}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {hint}
          </TooltipContent>
        </Tooltip>
      ) : (
        text
      )}
      {action ? (
        <span className="ml-auto font-sans normal-case tracking-normal">{action}</span>
      ) : null}
    </div>
  )
}

/** Managed by, Agents (workers and subagents) and Talking with. Mounted only while the list is open,
 *  so rows, live looks and their store selectors cost nothing at rest. */
export function NativeChatCrewStripGroups({
  crew,
  subagents,
  selfLabel,
  renderSubagent
}: {
  crew: NativeChatCrew
  subagents: readonly BackgroundRosterTask[]
  selfLabel: string
  renderSubagent: (task: BackgroundRosterTask) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { wantRows } = crew
  useEffect(() => wantRows(), [wantRows])
  const sections = crew.rows?.sections
  const managedBy = sections?.managedBy ?? NO_ROWS
  const workers = sections?.managing ?? NO_ROWS
  const talkingWith = sections?.talkingWith ?? NO_ROWS
  // One look per party: a party in two sections keeps one.
  const parties = useMemo(() => {
    const seen = new Set<string>()
    return [...managedBy, ...workers, ...talkingWith].filter(
      (row) => !seen.has(row.partyKey) && Boolean(seen.add(row.partyKey))
    )
  }, [managedBy, workers, talkingWith])
  const looks = useCrewRowLooks(parties, crew.target)
  const lookOf = useMemo(
    () => new Map(parties.map((row, index) => [row.partyKey, looks[index]!])),
    [parties, looks]
  )
  const rank = useCallback(
    (row: OrchestrationCrewRow) => STATUS_RANK[crewStatusGroup(lookOf.get(row.partyKey)!.status)],
    [lookOf]
  )
  const agents = useMemo(() => {
    const entries: AgentEntry[] = [
      ...workers.map((row, index) => ({ kind: 'worker' as const, row, rank: rank(row), index })),
      ...subagents.map((task, index) => ({
        kind: 'subagent' as const,
        task,
        rank: subagentRank(task.state),
        index
      }))
    ]
    // Workers before subagents at the same status; otherwise the host's order.
    return entries.sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.kind === 'subagent') - Number(b.kind === 'subagent') ||
        a.index - b.index
    )
  }, [workers, subagents, rank])
  const peers = useMemo(
    () =>
      talkingWith
        .map((row, index) => ({ row, index }))
        .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
        .map(({ row }) => row),
    [talkingWith, rank]
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((partyKey: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (!next.delete(partyKey)) {
        next.add(partyKey)
      }
      return next
    })
  }, [])
  const { mention: mentionAgents, canMention } = crew
  const mention = useCallback(
    (row: OrchestrationCrewRow, look: CrewRowLook) =>
      mentionAgents([{ row, agentType: look.agentType }]),
    [mentionAgents]
  )
  const crewRow = (row: OrchestrationCrewRow, badge?: string) => (
    <CrewStripRow
      key={row.partyKey}
      row={row}
      look={lookOf.get(row.partyKey)!}
      target={crew.target}
      badge={badge}
      selfLabel={selfLabel}
      canMention={canMention}
      mention={mention}
      expanded={expanded.has(row.partyKey)}
      toggle={toggle}
    />
  )
  const running = workers.filter(runningWorker)
  const workerBadge = t('components.native-chat.backgroundTasks.workerBadge', 'Worker')
  const managedByLabel = t('components.orchestrationCrew.managedBy', 'Managed by')
  const agentsLabel = say('groupAgents')
  const talkingWithLabel = t('components.orchestrationCrew.talkingWith', 'Talking with')
  return (
    <>
      {managedBy.length > 0 ? (
        <StripGroup>
          <StripGroupHeading label={managedByLabel} count={managedBy.length} />
          <ul role="list" aria-label={managedByLabel} className="space-y-0.5">
            {managedBy.map((row) => crewRow(row))}
          </ul>
        </StripGroup>
      ) : null}
      {agents.length > 0 ? (
        <StripGroup>
          <StripGroupHeading
            label={agentsLabel}
            count={agents.length}
            action={
              workers.length > 0 ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="h-5"
                  disabled={!canMention || running.length === 0}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() =>
                    mentionAgents(
                      running.map((row) => ({
                        row,
                        agentType: lookOf.get(row.partyKey)!.agentType
                      }))
                    )
                  }
                >
                  {t('components.orchestrationCrew.mentionAll', 'Mention all')}
                </Button>
              ) : undefined
            }
          />
          <ul role="list" aria-label={agentsLabel} className="space-y-0.5">
            {agents.map((entry) =>
              entry.kind === 'worker' ? crewRow(entry.row, workerBadge) : renderSubagent(entry.task)
            )}
          </ul>
        </StripGroup>
      ) : null}
      {peers.length > 0 ? (
        <StripGroup>
          <StripGroupHeading
            label={talkingWithLabel}
            count={peers.length}
            hint={t(
              'components.orchestrationCrew.talkingWithHint',
              'Messaged this chat in the last 30 min'
            )}
          />
          <ul role="list" aria-label={talkingWithLabel} className="space-y-0.5">
            {peers.map((row) => crewRow(row))}
          </ul>
        </StripGroup>
      ) : null}
    </>
  )
}

const NO_ROWS: readonly OrchestrationCrewRow[] = []

/** Groups after the first are ruled off from the one above. */
export function StripGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="not-first:mt-1.5 not-first:border-t not-first:border-border/60 not-first:pt-1.5">
      {children}
    </div>
  )
}
