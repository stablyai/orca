import { useCallback, type MouseEvent } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { CompactAgentRow } from '@/components/sidebar/workspace-card/activity/worktree-card-compact-agent-row'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { activateWorktreeAgentPane } from '@/components/sidebar/workspace-card/activity/use-worktree-agent-activation'
import { activateRetainedAgentRow } from '@/components/sidebar/workspace-card/activity/activate-retained-agent-row'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { AGENT_LIST_STATUS_RANK } from '../../../../../shared/agent-status/presentation/agent-list-status'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import type { Worktree } from '../../../../../shared/worktree/types'

/** The agent sessions of the workspace that has this ref checked out, so the graph tells who worked on a branch. */
export function GitGraphRefWorkspaceAgents({
  worktree,
  focusable = true
}: {
  worktree: Worktree
  /** False inside another button, such as a commits-list row, where a nested button is invalid. */
  focusable?: boolean
}) {
  const t = useTranslate()
  const rows = useWorktreeAgentRows(worktree.id)
  const now = useNow(30_000, rows.length > 0)
  const onActivate = useCallback(
    (tabId: string, paneKey: string) => {
      const row = rows.find((candidate) => candidate.paneKey === paneKey)
      if (row?.rowSource === 'retained') {
        activateRetainedAgentRow(worktree.id, tabId, paneKey)
      } else {
        activateWorktreeAgentPane(worktree.id, tabId, paneKey)
      }
    },
    [rows, worktree.id]
  )
  if (rows.length === 0) {
    return null
  }
  // The chip shows the session needing attention first, as the sidebar card does.
  const state = rows
    .map(agentRowDisplayDotState)
    .reduce((top, next) =>
      AGENT_LIST_STATUS_RANK[next] < AGENT_LIST_STATUS_RANK[top] ? next : top
    )
  const label = t('gitGraph.workspaceAgents', 'Agents in this workspace')
  const trigger = {
    className:
      'inline-flex shrink-0 items-center gap-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
    'aria-label': t(
      'gitGraph.workspaceAgentsSummary',
      'Agents in this workspace: {{sessions}}, {{state}}',
      { sessions: rows.length, state: agentStateLabel(state) }
    ),
    // Hovering the marker must not select or expand the row under it.
    onClick: (event: MouseEvent) => event.stopPropagation()
  }
  const marker = (
    <>
      <AgentStateDot state={state} title={null} />
      {rows.length > 1 && <span className="text-2xs leading-none tabular-nums">{rows.length}</span>}
    </>
  )
  return (
    <HoverCard openDelay={200} closeDelay={120}>
      <HoverCardTrigger asChild>
        {focusable ? (
          <button type="button" {...trigger}>
            {marker}
          </button>
        ) : (
          <span role="img" {...trigger}>
            {marker}
          </span>
        )}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        variant="workspace-details"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        {rows.map((agent) => (
          <CompactAgentRow
            key={agent.paneKey}
            agent={agent}
            now={now}
            showModel={false}
            cacheTimerActive={false}
            onActivate={onActivate}
          />
        ))}
      </HoverCardContent>
    </HoverCard>
  )
}
