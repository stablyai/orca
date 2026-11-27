import { createContext, useContext } from 'react'
import type { SendTarget } from '@/components/sidebar/workspace-card/activity/worktree-agent-branch-context'

export type ActivityThreadSendTargets = {
  targets: Map<string, SendTarget>
  onSend: (paneKey: string) => void
}

// Why context: the open send picker reaches memoized virtual rows without threading props through the list pane.
export const ActivityThreadSendTargetsContext = createContext<ActivityThreadSendTargets | null>(
  null
)

export function useActivityThreadSendTarget(
  paneKey: string
): { target: SendTarget; onSend: (paneKey: string) => void } | null {
  const sendTargets = useContext(ActivityThreadSendTargetsContext)
  const target = sendTargets?.targets.get(paneKey)
  return sendTargets && target ? { target, onSend: sendTargets.onSend } : null
}
