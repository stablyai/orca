import type { MutableRefObject } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { AgentMapAgentLabelPlacement } from './agent-map-agent-label-layout'
import type { AgentMapAgentNode } from './agent-map-layout'
import { AgentMapQuestionMarker } from './AgentMapQuestionMarker'
import type { AgentMapFlareStatus } from './agent-map-node-metadata'
import {
  agentMapAgentAriaLabel,
  agentMapAttentionMarkerScale,
  agentName
} from './agent-map-node-presentation'

type AgentMapAgentNodeViewProps = {
  agent: AgentMapAgentNode
  projectName: string
  worktreeName: string
  mapScale: number
  labelPlacement: AgentMapAgentLabelPlacement
  selectedPaneKey: string | null
  exiting: boolean
  flareStatus: AgentMapFlareStatus | undefined
  nodeRefs: MutableRefObject<Map<string, SVGGElement>>
  onSelectAgent: (card: DashboardCard) => void
  onHoverChange: (paneKey: string, active: boolean) => void
  onFocusChange: (paneKey: string, active: boolean) => void
  onAgentKeyDown: (event: React.KeyboardEvent<SVGGElement>, agent: AgentMapAgentNode) => void
}

export function AgentMapAgentNodeView({
  agent,
  projectName,
  worktreeName,
  mapScale,
  labelPlacement,
  selectedPaneKey,
  exiting,
  flareStatus,
  nodeRefs,
  onSelectAgent,
  onHoverChange,
  onFocusChange,
  onAgentKeyDown
}: AgentMapAgentNodeViewProps): React.JSX.Element {
  const iconSize = Math.max(12, Math.min(22, agent.radius * 1.05))
  const name = agentName(agent.card)
  const agentExiting = exiting || agent.motionState === 'exiting'
  // `done` here is the unread finish only — `done-seen` demotes to a bare
  // emerald ring so the halo keeps meaning "this one is still unread".
  const hasStatusGlow =
    agent.status === 'working' ||
    agent.status === 'waiting' ||
    agent.status === 'blocked' ||
    agent.status === 'done'

  return (
    <g
      ref={(node) => {
        if (node) {
          nodeRefs.current.set(agent.card.paneKey, node)
        } else {
          nodeRefs.current.delete(agent.card.paneKey)
        }
      }}
      data-agent-map-agent=""
      data-agent-provider={agent.card.agentType}
      role="button"
      tabIndex={agentExiting ? -1 : 0}
      aria-hidden={agentExiting || undefined}
      aria-pressed={selectedPaneKey === agent.card.paneKey}
      aria-label={agentMapAgentAriaLabel(agent, worktreeName, projectName)}
      className={`agent-map-agent-node fleet-status-${agent.status}${selectedPaneKey === agent.card.paneKey ? ' is-selected' : ''}${agent.motionState ? ` is-${agent.motionState}` : ''}`}
      transform={`translate(${agent.x} ${agent.y})`}
      onPointerEnter={() => {
        if (!agentExiting) {
          onHoverChange(agent.card.paneKey, true)
        }
      }}
      onPointerLeave={() => onHoverChange(agent.card.paneKey, false)}
      onFocus={() => {
        if (!agentExiting) {
          onFocusChange(agent.card.paneKey, true)
        }
      }}
      onBlur={() => onFocusChange(agent.card.paneKey, false)}
      onClick={(event) => {
        if (agentExiting) {
          return
        }
        event.currentTarget.focus()
        onSelectAgent(agent.card)
      }}
      onKeyDown={(event) => {
        if (!agentExiting) {
          onAgentKeyDown(event, agent)
        }
      }}
    >
      <g className="agent-map-agent-visual">
        {hasStatusGlow ? (
          <circle
            className={`agent-map-agent-status-glow fleet-status-${agent.status}`}
            data-agent-map-agent-status-glow=""
            data-agent-active-status={agent.status}
            r={agent.radius + 1}
            aria-hidden="true"
          />
        ) : null}
        {flareStatus && !agentExiting ? (
          <circle
            className={`agent-map-agent-status-flare fleet-status-${flareStatus}`}
            data-agent-map-agent-status-flare=""
            r={agent.radius + 1}
            aria-hidden="true"
          />
        ) : null}
        <circle className="agent-map-agent-hit" r={Math.max(10, agent.radius + 3)} />
        <circle className="agent-map-agent-mark" r={agent.radius} />
        <foreignObject
          className="agent-map-agent-icon"
          x={-iconSize / 2}
          y={-iconSize / 2}
          width={iconSize}
          height={iconSize}
        >
          <div>
            <AgentIcon agent={agentTypeToIconAgent(agent.card.agentType)} size={iconSize} />
          </div>
        </foreignObject>
        {agent.card.unseen ? (
          <circle
            className="agent-map-agent-unread-mark"
            data-agent-unread-marker=""
            cx={-agent.radius * Math.SQRT1_2}
            cy={-agent.radius * Math.SQRT1_2}
            r={agent.radius * 0.225 * agentMapAttentionMarkerScale(mapScale)}
            vectorEffect="none"
            aria-hidden="true"
          />
        ) : null}
        {agent.status === 'waiting' ? (
          <AgentMapQuestionMarker
            radius={agent.radius}
            markerScale={agentMapAttentionMarkerScale(mapScale)}
          />
        ) : null}
      </g>
      <g className="agent-map-agent-label-group" transform={`scale(${labelPlacement.scale})`}>
        <foreignObject
          className="agent-map-agent-label-frame"
          x={labelPlacement.x}
          y={labelPlacement.y}
          width={labelPlacement.width}
          height={labelPlacement.height}
        >
          <div className="agent-map-agent-label" data-agent-map-agent-label="">
            <span className="agent-map-agent-name">{name}</span>
          </div>
        </foreignObject>
      </g>
    </g>
  )
}
