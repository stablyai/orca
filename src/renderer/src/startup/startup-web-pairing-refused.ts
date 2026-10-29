import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebClient } from '../components/sidebar/worktree-card-model'
import { isWebRuntimeUnauthorizedError } from '../web/web-runtime-client-error'

// Credential refusals need their actionable translated reason; generic restore failure hides it.
export function isWebPairingRefusedAtStartup(error: unknown): error is Error {
  return isWebClient() && isWebRuntimeUnauthorizedError(error)
}

export function announceWebPairingRefusedAtStartup(error: Error): void {
  toast.error(translate('auto.startup.webPairingRefused.title', 'Orca refused this browser'), {
    // The error already carries the reason-specific, translated guidance.
    description: error.message,
    duration: Infinity,
    dismissible: true,
    action: {
      label: translate('auto.startup.webPairingRefused.retry', 'Try again'),
      onClick: () => {
        void window.api.app.relaunch()
      }
    }
  })
}
