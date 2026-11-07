import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { copyAgentSessionContext } from '@/lib/copy-agent-session-context'
import {
  resolveNativeChatSessionContext,
  type NativeChatSessionContextSource
} from '../routing/native-chat-session-context'

export type NativeChatSessionMenuSource = Omit<NativeChatSessionContextSource, 'epoch'> & {
  epoch: string | null
  agent: AgentType
  focusSource: () => void
}

export function useNativeChatSessionContextActions(
  source: NativeChatSessionMenuSource | undefined
) {
  const [pending, setPending] = useState(false)
  const operation = useRef(0)
  const busy = useRef(false)
  const hostId = source ? executionHostIdForStructuredTarget(source.target) : null
  const retire = useCallback(() => {
    operation.current++
  }, [])
  useLayoutEffect(() => {
    retire()
    busy.current = false
    setPending(false)
    return retire
  }, [source?.sessionId, hostId, source?.epoch, source?.worktreeId, retire])

  const copy = async (): Promise<void> => {
    if (!source?.epoch || busy.current) {
      return
    }
    const current = ++operation.current
    busy.current = true
    setPending(true)
    try {
      const context = await resolveNativeChatSessionContext({ ...source, epoch: source.epoch })
      if (operation.current !== current || !context) {
        return
      }
      const noContext = translate(
        'components.native-chat.contextMenu.noSessionContext',
        'No chat context is available.'
      )
      await copyAgentSessionContext(context.capturedText, source.focusSource, noContext)
    } finally {
      if (operation.current === current) {
        busy.current = false
        setPending(false)
      }
    }
  }
  return {
    available: Boolean(source?.epoch),
    pending,
    onCopy: () => void copy()
  }
}
