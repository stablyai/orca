import { useCallback, useMemo, useState } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  latestNativeChatUserTurnKey,
  shouldSuppressNativeChatWorking,
  type NativeChatWorkingInterruption
} from './native-chat-working-suppression'

export function useNativeChatWorkingInterruption(args: {
  working: boolean
  paneKey: string
  agent: AgentType
  sessionId: string | null
  workingEpoch: number | null
  messages: NativeChatMessage[]
}) {
  const [interruption, setInterruption] = useState<NativeChatWorkingInterruption | null>(null)
  const userTurnKey = useMemo(() => latestNativeChatUserTurnKey(args.messages), [args.messages])
  const interruptWorking = useCallback(() => {
    setInterruption({
      paneKey: args.paneKey,
      agent: args.agent,
      sessionId: args.sessionId,
      workingEpoch: args.workingEpoch,
      userTurnKey
    })
  }, [args.agent, args.paneKey, args.sessionId, args.workingEpoch, userTurnKey])
  const resumeWorking = useCallback(() => setInterruption(null), [])
  const interrupted = shouldSuppressNativeChatWorking({ ...args, userTurnKey, interruption })
  return { interrupted, interruptWorking, resumeWorking }
}
