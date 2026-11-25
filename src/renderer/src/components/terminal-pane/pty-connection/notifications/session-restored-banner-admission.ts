import type { SessionRestoredBannerReason } from '../../session-restore/session-restored-banner-pane-state'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindSessionRestoredBannerAdmission(session: ConnectPanePtySession): void {
  let sessionRestoredBannerShown: SessionRestoredBannerReason | null = null
  session.showSessionRestoredBanner = (reason: SessionRestoredBannerReason = 'restored'): void => {
    // Allow unavailable outcome to replace restored wording; an earlier plain banner cannot certify a session that failed to resume.
    if (
      sessionRestoredBannerShown === reason ||
      sessionRestoredBannerShown === 'resume-unavailable'
    ) {
      return
    }
    sessionRestoredBannerShown = reason
    session.deps.onShowSessionRestoredBanner(session.pane.id, reason)
  }
}
