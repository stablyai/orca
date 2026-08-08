import { memo } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentMapWorktreeRing } from './agent-map-layout'

type AgentMapWorktreeLabelProps = {
  worktree: AgentMapWorktreeRing
  visible: boolean
  active: boolean
  labelScale: number
  mapScale: number
}

export const AgentMapWorktreeLabel = memo(function AgentMapWorktreeLabel({
  worktree,
  visible,
  active,
  labelScale,
  mapScale
}: AgentMapWorktreeLabelProps): React.JSX.Element {
  const showCount = visible && (active || worktree.radius * mapScale >= 80)
  const agentCountText = translate(
    'dashboardPopout.map.agentCount',
    worktree.agents.length === 1 ? '{{count}} agent' : '{{count}} agents',
    { count: worktree.agents.length }
  )
  return (
    <g
      className={`agent-map-worktree-label-group${visible ? ' is-visible' : ''}${active ? ' is-active' : ''}${showCount ? ' is-count-visible' : ''}`}
      transform={`translate(${worktree.x} ${worktree.y - worktree.radius}) scale(${labelScale})`}
    >
      <text className="agent-map-worktree-label" y={18}>
        {worktree.name}
      </text>
      <text className="agent-map-worktree-count" y={32}>
        {agentCountText}
      </text>
    </g>
  )
})
