import type { RuntimeTerminalDriverState } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { TerminalViewMode } from '../../../../../shared/terminal-view-mode.ts'

/** Mirror terminal mobile-driver locks; unresolved driver state stays usable until send-time PTY validation. */
export function deriveNativeChatCanSend(
  driver: RuntimeTerminalDriverState | null | undefined
): boolean {
  return driver?.kind !== 'mobile'
}

/** Chat communicates the mobile lock in its composer; suppress the still-mounted terminal overlay above it. */
export function shouldChatTakeOverMobileSurface(viewMode: TerminalViewMode): boolean {
  return viewMode === 'chat'
}
