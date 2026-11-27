import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import {
  BOT_WORKSPACE_LINE_LOGO,
  botWorkspaceLineAgent,
  type BotWorkspaceLineAgent
} from '../../../../../../shared/bots/bot-sidebar-workspaces'
import { overlapCutoutMask } from '@/lib/overlap-cutout-mask'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

/** What a one-line card says about its agents; the hover card lists every one. */
export function useWorktreeLineAgent(worktreeId: string): BotWorkspaceLineAgent | null {
  const rows = useWorktreeAgentRows(worktreeId)
  return botWorkspaceLineAgent(
    rows.map((row) => ({
      agentType: row.agentType,
      subagent: row.rowSource === 'subagent',
      state: row.state
    }))
  )
}

/** A one-line card's agents by logo, one per kind, overlapping like the group faces; none when no agent reports. */
export function WorktreeCardLineAgents({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const agent = useWorktreeLineAgent(worktreeId)
  if (!agent) {
    return null
  }
  const { size, step, gap } = BOT_WORKSPACE_LINE_LOGO
  const logos = agent.agentTypes.map((type, index) => ({ type, x: index * step, y: 0, size }))
  return (
    <span
      role="img"
      aria-label={agent.agentTypes.map((type) => formatAgentTypeLabel(type, t)).join(', ')}
      className="relative shrink-0"
      style={{ width: (logos.length - 1) * step + size, height: size }}
      data-worktree-card-line-agent=""
    >
      {logos.map((logo, index) => (
        <span
          key={logo.type}
          className="absolute flex items-center justify-center"
          // The cut shows the row's own background in every state, as the group faces do.
          style={{
            left: logo.x,
            top: 0,
            width: size,
            height: size,
            ...overlapCutoutMask(logo, logos.slice(index + 1), gap)
          }}
        >
          <AgentTypeIcon agentType={logo.type} size={size} />
        </span>
      ))}
    </span>
  )
}
