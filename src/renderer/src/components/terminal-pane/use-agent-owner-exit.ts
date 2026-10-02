import { useEffect, useRef } from 'react'
import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../../shared/agent-process-presence'
import type { AgentPresenceByPaneKey } from '@/store/slices/agent-presence'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Deliver the host exit even when no terminal bytes or foreground changes arrive. */
export function useAgentOwnerExit(
  records: AgentPresenceByPaneKey,
  tabId: string,
  leafId: string | null,
  onExit: (leafId: string, exit: 'exited') => void
): void {
  const observed = useRef<AgentProcessPresence | undefined>(undefined)
  useEffect(() => {
    const presence = leafId ? records[makePaneKey(tabId, leafId)]?.presence : undefined
    const previous = observed.current
    observed.current = presence
    // Why: only a live→ended transition is an exit; a record already ended at mount is history.
    if (
      leafId &&
      presence?.process &&
      presence.ended &&
      previous?.process &&
      !previous.ended &&
      isSameAgentProcess(previous.process, presence.process)
    ) {
      onExit(leafId, 'exited')
    }
  }, [records, tabId, leafId, onExit])
}
