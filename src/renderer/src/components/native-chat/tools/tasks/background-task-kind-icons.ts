import { Activity, Bot, CircleHelp, SquareTerminal, Workflow } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'

export const KIND_ICONS = {
  agent: Bot,
  command: SquareTerminal,
  monitor: Activity,
  workflow: Workflow,
  unknown: CircleHelp
} as const

/** Match the sidebar’s amber monitoring state; other kind icons stay neutral, and running turns dim the strip. */
export function kindIconTone(kind: AgentSessionBackgroundTask['kind'], dimmed: boolean): string {
  const tone = kind === 'monitor' ? 'text-yellow-500' : 'text-muted-foreground'
  return dimmed ? `${tone}/40` : tone
}
