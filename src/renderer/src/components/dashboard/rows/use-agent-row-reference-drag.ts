import { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import {
  agentStatusEntrySendAddress,
  writeAgentReferenceDragData
} from '@/lib/agent-session/messaging/agent-reference-drag'
import type { DashboardAgentRow } from './dashboard-agent-row'

const AGENT_REFERENCE_LABEL_MAX_LENGTH = 60

function agentReferenceLabel(name: string): string {
  const label = name.replace(/\s+/gu, ' ').trim()
  return label.length > AGENT_REFERENCE_LABEL_MAX_LENGTH
    ? `${label.slice(0, AGENT_REFERENCE_LABEL_MAX_LENGTH - 1).trimEnd()}…`
    : label
}

/** Lets a row be dragged into a chat composer, which mentions its agent as the crew panel does. */
export function useAgentRowReferenceDrag(
  agent: DashboardAgentRow,
  name: string,
  disabled: boolean
): { draggable: boolean; onDragStart: (event: React.DragEvent<HTMLElement>) => void } {
  // Subagent rows have no pane of their own, so their entry's address names the parent.
  const address =
    disabled || agent.rowSource === 'subagent' ? null : agentStatusEntrySendAddress(agent.entry)
  const label = agentReferenceLabel(name)
  const worktreeId = agent.tab.worktreeId
  const draggable = address !== null && label.length > 0
  const onDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || !address) {
        return
      }
      // The enclosing workspace card is draggable too; this gesture moves the agent, not the card.
      event.stopPropagation()
      // Read at drag time: subscribing every sidebar row to owner routing would re-render them all.
      const target = tryRuntimeTargetForWorktreeOwner(useAppStore.getState(), worktreeId)
      if (!target) {
        event.preventDefault()
        return
      }
      writeAgentReferenceDragData(event.dataTransfer, {
        label,
        address,
        hostKey: target.kind === 'local' ? 'local' : target.environmentId
      })
    },
    [address, label, worktreeId]
  )
  return { draggable, onDragStart }
}
