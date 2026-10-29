import type { DriverState } from '@/lib/pane-manager/mobile-driver-state'

/** Mirror terminal mobile-driver locks; unresolved driver state stays usable until send-time PTY validation. */
export function deriveNativeChatCanSend(driver: DriverState | null | undefined): boolean {
  return driver?.kind !== 'mobile'
}

/** Chat communicates the mobile lock in its composer; suppress the still-mounted terminal overlay above it. */
export function shouldChatTakeOverMobileSurface(viewMode: 'terminal' | 'chat'): boolean {
  return viewMode === 'chat'
}
