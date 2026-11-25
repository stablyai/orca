import { useMemo } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { AgentStateDot, type AgentDotState } from '@/components/agent/status/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { cn } from '@/lib/class-names'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import {
  useAgentMessageSenderViews,
  type AgentMessageSenderInput
} from '../native-chat/messages/agent-senders/native-chat-agent-message-sender-view'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  isOrcaSessionId,
  formatOrcaSessionAddress
} from '../../../../shared/agent-session/identity/orca-session-address'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/view/messages/agent-message-presentation'
import { crewPartyDotState, crewPartyStatus } from './crew-party-status'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type CrewRowLook = {
  partyKey: string
  status: WorktreeStatus
  dotState: AgentDotState
  agentType: string
}

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

function crewRowLook(row: OrchestrationCrewRow, view: AgentMessageSenderView): CrewRowLook {
  const party = { dot: view.dot, status: row.status, taskFailed: row.task?.state === 'failed' }
  return {
    partyKey: row.partyKey,
    status: crewPartyStatus(party),
    dotState: crewPartyDotState(party),
    agentType: view.agentType ?? row.agentKind
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

function agentLabel(agentType: string, hostLabel: string | undefined, t: Translate): string {
  const label = isTuiAgent(agentType)
    ? getAgentLabel(agentType)
    : formatAgentTypeLabel(agentType, t)
  return hostLabel ? `${label} · ${hostLabel}` : label
}

/** The sidebar agent rows' status icon and agent icon, without a container. */
export function CrewAgentIcons({
  look,
  hostLabel
}: {
  look: CrewRowLook
  hostLabel?: string
}): React.JSX.Element {
  const label = agentLabel(look.agentType, hostLabel, useTranslate())
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <AgentStateDot state={look.dotState} size="sm" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={label} className="inline-flex shrink-0">
            <AgentTypeIcon agentType={look.agentType} size={13} className="size-[13px]" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
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
          key={look.partyKey}
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
