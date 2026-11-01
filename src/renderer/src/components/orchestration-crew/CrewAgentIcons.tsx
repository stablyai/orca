import { useMemo } from 'react'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { cn } from '@/lib/utils'
import { getAgentLabel } from '@/lib/agent-catalog'
import { mapAgentStatusStateToVisualStatus } from '@/lib/agent-status'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import {
  useAgentMessageSenderViews,
  type AgentMessageSenderInput
} from '../native-chat/native-chat-agent-message-sender-view'
import { isAgentStatusState } from '../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { isOrcaSessionId, formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type CrewRowLook = { status: WorktreeStatus; agentType: string }
export type CrewStatusGroup = 'needsYou' | 'working' | 'idle' | 'failed'
export const CREW_STATUS_GROUPS: readonly CrewStatusGroup[] = [
  'needsYou',
  'working',
  'idle',
  'failed'
]

// Imported, missing, dispatch and other-host parties keep the Crew snapshot's own state.
function crewRowSender(row: OrchestrationCrewRow): AgentMessageSenderInput {
  const location = row.hostLabel ? undefined : row.openTarget
  if (location?.kind === 'chat' && isOrcaSessionId(location.sessionId)) {
    return {
      sender: {
        name: row.label,
        party: {
          address: formatOrcaSessionAddress(location.sessionId),
          orcaSessionId: location.sessionId,
          terminalHandle: null
        }
      },
      worktreeId: location.worktreeId
    }
  }
  if (location?.kind === 'terminal') {
    return {
      sender: {
        name: row.label,
        party: { address: location.handle, terminalHandle: location.handle, orcaSessionId: null }
      },
      worktreeId: null
    }
  }
  return { sender: undefined, worktreeId: null }
}

function dotStatus(dot: NonNullable<AgentMessageSenderView['dot']>): WorktreeStatus {
  switch (dot) {
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'idle':
      return 'inactive'
    case 'unverifiable':
      return 'unconfirmed'
    case 'working':
    case 'monitoring':
    case 'interrupted':
    case 'failed':
    case 'done':
    case 'unconfirmed':
    case 'permission':
      return dot
  }
}

/** The sidebar's status for a Crew row: live sender state first, then the Crew snapshot. */
function crewRowLook(row: OrchestrationCrewRow, view: AgentMessageSenderView): CrewRowLook {
  const agentType = view.agentType ?? row.agentKind
  if (row.pendingQuestion) {
    return { status: 'permission', agentType }
  }
  if (view.dot) {
    return { status: dotStatus(view.dot), agentType }
  }
  const status = isAgentStatusState(row.status)
    ? mapAgentStatusStateToVisualStatus(row.status)
    : 'inactive'
  // A settled assignment whose task failed is a failure, not a quiet finish.
  return {
    status: status === 'done' && row.task?.state === 'failed' ? 'failed' : status,
    agentType
  }
}

export function crewStatusGroup(status: WorktreeStatus): CrewStatusGroup {
  switch (status) {
    case 'permission':
      return 'needsYou'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'failed':
      return 'failed'
    case 'active':
    case 'done':
    case 'inactive':
    case 'interrupted':
    case 'unconfirmed':
      return 'idle'
  }
}

// Rows and sender views keep their identity while unchanged, so a row's look does too.
const looks = new WeakMap<OrchestrationCrewRow, WeakMap<AgentMessageSenderView, CrewRowLook>>()
const NO_VIEW: AgentMessageSenderView = Object.freeze({})
function cachedLook(row: OrchestrationCrewRow, view: AgentMessageSenderView): CrewRowLook {
  let byView = looks.get(row)
  if (!byView) {
    byView = new WeakMap()
    looks.set(row, byView)
  }
  let look = byView.get(view)
  if (!look) {
    look = crewRowLook(row, view)
    byView.set(view, look)
  }
  return look
}

/** One store subscription resolves every row, so the closed tab can group by live state. */
export function useCrewRowLooks(
  rows: readonly OrchestrationCrewRow[],
  target: RuntimeClientTarget
): readonly CrewRowLook[] {
  const inputs = useMemo(() => rows.map(crewRowSender), [rows])
  const views = useAgentMessageSenderViews(inputs, target)
  return useMemo(
    () => rows.map((row, index) => cachedLook(row, views[index] ?? NO_VIEW)),
    [rows, views]
  )
}

function agentLabel(agentType: string, hostLabel: string | undefined): string {
  const label = isTuiAgent(agentType) ? getAgentLabel(agentType) : formatAgentTypeLabel(agentType)
  return hostLabel ? `${label} · ${hostLabel}` : label
}

/** The sidebar's small status icon and agent icon, without a container. */
export function CrewAgentIcons({
  look,
  hostLabel
}: {
  look: CrewRowLook
  hostLabel?: string
}): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <StatusIndicator
        status={look.status}
        role="img"
        aria-label={getWorktreeStatusLabel(look.status)}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={agentLabel(look.agentType, hostLabel)}
            className="inline-flex shrink-0"
          >
            <AgentTypeIcon agentType={look.agentType} size={13} className="size-[13px]" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {agentLabel(look.agentType, hostLabel)}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

/** Overlapping agent icons for one status group; the leftmost sits on top. */
export function CrewAgentStack({
  looks,
  limit = 3
}: {
  looks: readonly CrewRowLook[]
  limit?: number
}): React.JSX.Element {
  const shown = looks.slice(0, limit)
  return (
    <span className="inline-flex items-center">
      {shown.map((look, index) => (
        <span
          key={index}
          className={cn(
            'relative inline-flex size-4 items-center justify-center rounded-full bg-background',
            index > 0 && '-ml-1.5'
          )}
          style={{ zIndex: shown.length - index }}
        >
          <AgentTypeIcon agentType={look.agentType} size={13} className="size-[13px]" />
        </span>
      ))}
      {looks.length > limit ? (
        <span className="ml-0.5 text-[10px] tabular-nums text-muted-foreground">
          +{looks.length - limit}
        </span>
      ) : null}
    </span>
  )
}
