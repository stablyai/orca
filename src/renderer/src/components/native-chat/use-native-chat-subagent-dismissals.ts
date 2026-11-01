import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatSubagentActivity } from '../../../../shared/native-chat/input/native-chat-activity'
import {
  nativeChatDismissSubagents,
  nativeChatReconcileDismissals,
  nativeChatVisibleDismissedSubagents,
  type DismissedSubagentStates
} from '../../../../shared/native-chat/input/native-chat-subagent-dismissals'
import {
  readDismissedSubagents,
  writeDismissedSubagents
} from './native-chat-subagent-dismissal-storage'

export function useNativeChatSubagentDismissals(
  sessionId: string | null,
  listed: readonly NativeChatSubagentActivity[]
): {
  visible: NativeChatSubagentActivity[]
  dismiss: (agents: readonly NativeChatSubagentActivity[]) => void
} {
  const signature = listed.map((agent) => `${agent.id}\t${agent.state}`).join('\n')
  const listedRef = useRef(listed)
  listedRef.current = listed
  const [dismissed, setDismissed] = useState<DismissedSubagentStates>(() =>
    readDismissedSubagents(sessionId)
  )

  useEffect(() => {
    const loaded = readDismissedSubagents(sessionId)
    const next = nativeChatReconcileDismissals(loaded, listedRef.current)
    if (next !== loaded) {
      writeDismissedSubagents(sessionId, next)
    }
    setDismissed((current) => (sameDismissals(current, next) ? current : next))
  }, [sessionId, signature])

  const dismiss = useCallback(
    (agents: readonly NativeChatSubagentActivity[]) => {
      setDismissed((current) => {
        const next = nativeChatDismissSubagents(current, agents)
        writeDismissedSubagents(sessionId, next)
        return next
      })
    },
    [sessionId]
  )

  const visible = useMemo(
    () => nativeChatVisibleDismissedSubagents(listed, dismissed),
    [dismissed, listed]
  )
  return { visible, dismiss }
}

function sameDismissals(left: DismissedSubagentStates, right: DismissedSubagentStates): boolean {
  const leftIds = Object.keys(left)
  const rightIds = Object.keys(right)
  return leftIds.length === rightIds.length && leftIds.every((id) => left[id] === right[id])
}
