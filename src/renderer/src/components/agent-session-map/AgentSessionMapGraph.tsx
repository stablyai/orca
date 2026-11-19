import type {
  AgentMap,
  AgentMapNode,
  AgentMapNodeStatus,
  AgentMapViewState
} from '../../../../shared/agent-session-map/agent-session-map-model'
import { agentMapToolChipsAt } from '../../../../shared/agent-session-map/agent-session-map-tool-chips'
import type { AgentMapLayout } from '../../../../shared/agent-session-map/agent-session-map-layout'
import { AGENT_MAP_STATUS_COLORS, agentMapStatusLabel } from './agent-session-map-status-color'
import { translate } from '@/i18n/i18n'

export const AGENT_MAP_NODE_WIDTH = 168
export const AGENT_MAP_NODE_HEIGHT = 56
export const AGENT_MAP_CHIP_ROW_HEIGHT = 20

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A vertical elbow from a parent's bottom edge to a child's top edge. */
function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromHeight: number,
  toHeight: number
): string {
  const startY = from.y + fromHeight / 2
  const endY = to.y - toHeight / 2
  const midY = (startY + endY) / 2
  return `M ${from.x} ${startY} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${endY}`
}

export function AgentSessionMapGraph({
  map,
  layout,
  viewState,
  selectedNodeId,
  onSelectNode
}: {
  map: AgentMap
  layout: AgentMapLayout
  viewState: AgentMapViewState
  selectedNodeId?: string
  onSelectNode?: (nodeId: string) => void
}) {
  const nodeById = new Map(map.nodes.map((node) => [node.id, node]))
  const viewById = new Map(viewState.nodes.map((node) => [node.nodeId, node]))

  return (
    <svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={translate('components.agentSessionMap.graph.ariaLabel', 'Agent session map')}
      className="block"
    >
      <g>
        {layout.edges
          // Only draw an edge once both ends exist at this playhead — otherwise a
          // scrubbed-back view leaves a line dangling to a not-yet-spawned sub-agent.
          .filter((edge) => viewById.has(edge.fromId) && viewById.has(edge.toId))
          .map((edge) => {
            const color =
              AGENT_MAP_STATUS_COLORS[viewById.get(edge.toId)?.status ?? 'unknown'].stroke
            return (
              <path
                key={`${edge.fromId}-${edge.toId}`}
                d={edgePath(edge.from, edge.to, edge.fromHeight, edge.toHeight)}
                fill="none"
                stroke={color}
                strokeOpacity={0.45}
                strokeWidth={1.5}
              />
            )
          })}
      </g>
      <g>
        {[...layout.positions.entries()].map(([id, position]) => {
          const view = viewById.get(id)
          const node = nodeById.get(id)
          if (!view || !node) {
            return null
          }
          return (
            <MapNode
              key={id}
              x={position.x}
              y={position.y}
              node={node}
              ts={viewState.ts}
              label={node.label}
              status={view.status}
              activeTool={
                view.activeTool
                  ? `${view.activeTool.name}${view.activeTool.summary ? ` · ${view.activeTool.summary}` : ''}`
                  : undefined
              }
              waitingOn={view.waitingOn}
              isRoot={id === map.rootId}
              selected={id === selectedNodeId}
              onSelect={onSelectNode ? () => onSelectNode(id) : undefined}
            />
          )
        })}
      </g>
    </svg>
  )
}

function MapNode({
  x,
  y,
  node,
  ts,
  label,
  status,
  activeTool,
  waitingOn,
  isRoot,
  selected,
  onSelect
}: {
  x: number
  y: number
  node: AgentMapNode
  ts: number
  label: string
  status: AgentMapNodeStatus
  activeTool?: string
  waitingOn?: string
  isRoot: boolean
  selected: boolean
  onSelect?: () => void
}) {
  const color = AGENT_MAP_STATUS_COLORS[status]
  const left = x - AGENT_MAP_NODE_WIDTH / 2
  const top = y - AGENT_MAP_NODE_HEIGHT / 2
  const subtitle =
    status === 'running' && activeTool
      ? activeTool
      : status === 'waiting' && waitingOn
        ? translate('components.agentSessionMap.node.waitingOn', 'Waiting on {{target}}', {
            target: waitingOn
          })
        : isRoot
          ? translate('components.agentSessionMap.node.mainAgent', 'Main agent')
          : agentMapStatusLabel(status)
  const chips = agentMapToolChipsAt(node.toolCalls, ts)
  return (
    <g
      transform={`translate(${left}, ${top})`}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${label} — ${agentMapStatusLabel(status)}`}
      className={onSelect ? 'cursor-pointer outline-none' : undefined}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect()
              }
            }
          : undefined
      }
    >
      {selected && (
        <rect
          x={-3}
          y={-3}
          width={AGENT_MAP_NODE_WIDTH + 6}
          height={AGENT_MAP_NODE_HEIGHT + 6}
          rx={15}
          fill="none"
          stroke="var(--color-ring)"
          strokeWidth={2}
        />
      )}
      <rect
        width={AGENT_MAP_NODE_WIDTH}
        height={AGENT_MAP_NODE_HEIGHT}
        rx={12}
        fill={color.fill}
        stroke={color.stroke}
        strokeWidth={status === 'running' || status === 'waiting' ? 2 : 1.25}
      />
      <circle cx={16} cy={20} r={5} fill={color.stroke} />
      <text
        x={30}
        y={24}
        fill="var(--color-foreground)"
        fontSize={13}
        fontWeight={600}
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {truncate(label, 18)}
      </text>
      <text
        x={16}
        y={42}
        fill="var(--color-muted-foreground)"
        fontSize={11}
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {truncate(subtitle, 30)}
      </text>
      {chips.length > 0 && (
        <text
          x={16}
          y={AGENT_MAP_NODE_HEIGHT + 14}
          fontSize={10}
          fill="var(--color-muted-foreground)"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {chips.slice(0, 3).map((chip, i) => (
            <tspan key={chip.name}>
              {i > 0 ? '  ' : ''}
              {truncate(chip.name, 12)} ×{chip.count}
              {chip.failed > 0 && <tspan fill="var(--color-destructive)"> ✗{chip.failed}</tspan>}
              {chip.running > 0 && <tspan fill="var(--color-primary)"> ●</tspan>}
            </tspan>
          ))}
          {chips.length > 3 && (
            <tspan fill="var(--color-muted-foreground)"> +{chips.length - 3}</tspan>
          )}
        </text>
      )}
    </g>
  )
}
