import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Copies a key or secret through the secret clipboard; where the clear isn't promised, the toast says so. */
export function copyWebhookSecret(text: string, copied: string): void {
  void window.api.ui
    .writeSecretClipboardText(text)
    .then(({ clearsLater }) => {
      toast.success(
        clearsLater
          ? copied
          : `${copied}. ${translate('bots.webhooks.copiedNoClear', 'Clear your clipboard when you’re done; this browser can’t promise to clear it for you.')}`
      )
    })
    .catch(() => {
      toast.error(translate('bots.webhooks.copyFailed', 'Couldn’t copy. Try again.'))
    })
}
