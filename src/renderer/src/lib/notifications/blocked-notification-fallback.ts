import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Notify once per session about blocked OS notifications so completion bursts do not nag.
let shownThisSession = false

export function showBlockedNotificationFallbackToast(): void {
  if (shownThisSession) {
    return
  }
  shownThisSession = true
  toast.warning(
    translate(
      'auto.lib.blocked.notification.fallback.de50bef680',
      'macOS is blocking Orca notifications'
    ),
    {
      description: translate(
        'auto.components.onboarding.mac.notification.permission.card.721d2bedb6',
        'Turn on Allow notifications for Orca in System Settings.'
      ),
      action: {
        label: translate(
          'auto.components.onboarding.NotificationStep.4f6a1da718',
          'Open System Settings'
        ),
        onClick: () => {
          void window.api.notifications.openSystemSettings()
        }
      }
    }
  )
}
