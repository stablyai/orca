import { useEffect, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'

const TERMINAL_ATTENTION_POLL_MS = 500

export type NativeChatTerminalAttention = 'codex-hooks-review'

function compactTerminalText(value: string): string {
  // Why: alternate-screen TUIs position words with cursor escapes, so prompt
  // detection cannot depend on literal spaces or terminal wrapping.
  return stripAnsiEscapeSequences(value).replace(/\s+/g, '').toLowerCase()
}

export function detectNativeChatTerminalAttention(
  screen: string | null | undefined,
  agent: AgentType
): NativeChatTerminalAttention | null {
  if (agent !== 'codex' || !screen) {
    return null
  }
  const text = compactTerminalText(screen)
  return text.includes('hooksneedreview') &&
    text.includes('trustallandcontinue') &&
    text.includes('continuewithouttrusting')
    ? 'codex-hooks-review'
    : null
}

export function useNativeChatTerminalAttention(args: {
  agent: AgentType
  isVisible: boolean
  readTerminalScreen?: () => string | null
}): NativeChatTerminalAttention | null {
  const { agent, isVisible, readTerminalScreen } = args
  const [attention, setAttention] = useState<NativeChatTerminalAttention | null>(() =>
    isVisible ? detectNativeChatTerminalAttention(readTerminalScreen?.() ?? null, agent) : null
  )

  useEffect(() => {
    const refresh = (): void =>
      setAttention(
        isVisible ? detectNativeChatTerminalAttention(readTerminalScreen?.() ?? null, agent) : null
      )
    refresh()
    if (!isVisible || agent !== 'codex' || !readTerminalScreen) {
      return
    }
    // Why: the mounted xterm screen is transport-neutral for local, SSH, and
    // runtime-owned panes. Polling its small visible buffer also clears the
    // blocker as soon as Codex replaces the prompt after the user's choice.
    const interval = window.setInterval(refresh, TERMINAL_ATTENTION_POLL_MS)
    return () => window.clearInterval(interval)
  }, [agent, isVisible, readTerminalScreen])

  return isVisible && agent === 'codex' ? attention : null
}
