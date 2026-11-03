import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import { translate } from '@/i18n/i18n'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { PreparedAgentSessionFork } from '../terminal-pane/terminal-agent-session-fork'
import { copyAgentSessionContext } from '@/lib/copy-agent-session-context'
import { TerminalAgentSessionForkDialog } from '../terminal-pane/TerminalAgentSessionForkDialog'
import {
  resolveNativeChatSessionContext,
  type NativeChatSessionContextSource
} from './native-chat-session-context'

export type NativeChatSessionMenuSource = Omit<NativeChatSessionContextSource, 'epoch'> & {
  epoch: string | null
  agent: AgentType
  focusSource: () => void
}

export function useNativeChatSessionContextActions(
  source: NativeChatSessionMenuSource | undefined
) {
  const [fork, setFork] = useState<PreparedAgentSessionFork | null>(null)
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
    setFork(null)
    return retire
  }, [source?.sessionId, hostId, source?.epoch, source?.worktreeId, retire])

  const prepare = async (action: 'fork' | 'copy'): Promise<void> => {
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
      if (action === 'copy') {
        await copyAgentSessionContext(context.capturedText, source.focusSource, noContext)
        return
      }
      const prompt = buildAgentSessionForkPrompt({
        capturedText: context.capturedText,
        sourceLabel: source.sessionId,
        agentLabel: source.agent
      })
      if (!prompt) {
        toast.error(noContext)
        source.focusSource()
        return
      }
      setFork({
        prompt,
        agent: isTuiAgent(source.agent) ? source.agent : null,
        worktreeId: source.worktreeId,
        focusSource: source.focusSource
      })
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
    onFork: () => void prepare('fork'),
    onCopy: () => void prepare('copy'),
    dialog: fork ? (
      <TerminalAgentSessionForkDialog
        open={fork !== null}
        fork={fork}
        onOpenChange={(open) => !open && setFork(null)}
      />
    ) : null
  }
}
