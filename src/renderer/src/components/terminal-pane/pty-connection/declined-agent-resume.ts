import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type DeclinedAgentResumeSession = Pick<
  ConnectPanePtySession,
  | 'cacheKey'
  | 'cancelStartupDraftPasteDelivery'
  | 'clearRegisteredStartupLaunchConfig'
  | 'pendingStartupCommand'
  | 'startupInjectTimer'
>

export function cancelDeclinedAgentResume(session: DeclinedAgentResumeSession): void {
  session.pendingStartupCommand = null
  if (session.startupInjectTimer !== null) {
    clearTimeout(session.startupInjectTimer)
    session.startupInjectTimer = null
  }
  session.cancelStartupDraftPasteDelivery()
  session.clearRegisteredStartupLaunchConfig()
  useAppStore.getState().clearPaneForegroundAgent(session.cacheKey)
}
