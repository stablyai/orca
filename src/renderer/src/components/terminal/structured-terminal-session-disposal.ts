import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import type { TerminalTabCloseReason } from '@/store/slices/terminal-tab-retirement'

const STRUCTURED_SESSION_CLOSE_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000] as const

export function structuredTerminalSessionId(
  unifiedTabs: readonly Tab[] | undefined,
  terminalTabId: string
): string | null {
  return (
    unifiedTabs?.find(
      (tab) =>
        tab.contentType === 'terminal' && tab.entityId === terminalTabId && tab.viewMode === 'chat'
    )?.structuredSessionId ?? null
  )
}

export async function closeStructuredTerminalSessionWithRetry(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<boolean> {
  for (const [attempt, delayMs] of STRUCTURED_SESSION_CLOSE_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    try {
      await closeStructuredAgentSession(target, sessionId)
      return true
    } catch (error) {
      if (attempt === STRUCTURED_SESSION_CLOSE_RETRY_DELAYS_MS.length - 1) {
        console.warn('[structured-agent-session] terminal close disposal failed', {
          sessionId,
          error
        })
      }
    }
  }
  return false
}

export function disposeStructuredTerminalSession({
  unifiedTabs,
  terminalTabId,
  target,
  reason
}: {
  unifiedTabs: readonly Tab[] | undefined
  terminalTabId: string
  target: RuntimeClientTarget
  reason: TerminalTabCloseReason
}): void {
  if (reason === 'pty-exit') {
    return
  }
  const structuredSessionId = structuredTerminalSessionId(unifiedTabs, terminalTabId)
  if (!structuredSessionId) {
    return
  }
  // Closing is idempotent; a short retry window covers a dropped renderer/host request after the
  // terminal surface has already been removed.
  void closeStructuredTerminalSessionWithRetry(target, structuredSessionId)
}
