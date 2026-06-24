import React from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  deriveTaskDotState,
  deriveTaskMessage,
  deriveTaskStatusLabel,
  type TaskMessage,
  type TaskStatusLabel
} from '@/lib/orchestrator-task-row'
import type { OrchestrationTaskNode } from '../../../../shared/runtime-types'

// Why (#7): the short status word is a fixed vocabulary, so map each token to an
// i18n key (with the English word as the fallback) instead of rendering raw.
const STATUS_LABEL_FALLBACK: Record<TaskStatusLabel, string> = {
  queued: 'queued',
  working: 'working',
  stalled: 'stalled',
  blocked: 'blocked',
  done: 'done',
  failed: 'failed'
}

function statusLabelText(label: TaskStatusLabel): string {
  return translate(
    `auto.components.right.sidebar.OrchestratorMissionControl.task_status_${label}`,
    STATUS_LABEL_FALLBACK[label]
  )
}

function messageText(message: TaskMessage): string {
  if (!message) {
    return ''
  }
  if (message.kind === 'signal') {
    return message.text
  }
  return translate(
    'auto.components.right.sidebar.OrchestratorMissionControl.task_waiting_on',
    'waiting on {{value0}}',
    { value0: message.dep }
  )
}

// Why (#7 O2): one task in the coordinator's live DAG, rendered in the shared
// dot | icon | message vocabulary (AgentStateDot + agent glyph) so the Control
// Panel mirrors the feature-wall storyboard on real data. The dot state and the
// agent glyph are the only status visuals — no new ones are invented.
export function MissionControlTaskRow({
  node,
  nodesById
}: {
  node: OrchestrationTaskNode
  nodesById: Map<string, OrchestrationTaskNode>
}): React.JSX.Element {
  const dot = deriveTaskDotState(node)
  const statusLabel = statusLabelText(deriveTaskStatusLabel(node))
  const message = messageText(deriveTaskMessage(node, nodesById))
  const agent = node.dispatch?.assigneeAgent ?? null

  return (
    <div
      className="grid items-center gap-2 px-1"
      style={{ gridTemplateColumns: '16px 16px minmax(0, 1fr)' }}
    >
      <span className="inline-flex items-center justify-center">
        <AgentStateDot state={dot} size="sm" />
      </span>
      <span className="inline-flex items-center justify-center">
        {/* Only show the agent glyph once a worker is assigned; an unassigned
            (queued) task has no agent and renders an empty cell, not a "?". */}
        {node.dispatch ? <AgentIcon agent={agent} size={13} /> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="shrink-0 truncate font-medium text-foreground">{node.title}</span>
        <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
        {message ? (
          <span className="min-w-0 truncate text-muted-foreground/80">· {message}</span>
        ) : null}
      </span>
    </div>
  )
}
