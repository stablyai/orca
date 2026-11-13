import type { RuntimeTerminalDriverState } from '../../../../../shared/runtime-session-contracts'

/** Mirror terminal mobile-driver locks; unresolved driver state stays usable until send-time PTY validation. */
export function deriveNativeChatCanSend(
  driver: RuntimeTerminalDriverState | null | undefined
): boolean {
  return driver?.kind !== 'mobile'
}

/** Chat communicates the mobile lock in its composer; suppress the still-mounted terminal overlay above it. */
export function shouldChatTakeOverMobileSurface(viewMode: 'terminal' | 'chat'): boolean {
  return viewMode === 'chat'
}
