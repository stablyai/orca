import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { joinSentences, sentenceStop } from '../../../../../shared/text/sentence-joining'

/** Copies a key or secret through the secret clipboard; where the clear isn't promised, the toast says so.
 *  `quiet`: the caller shows the copy itself, so only that warning toasts. Resolves whether it copied. */
export function copyWebhookSecret(
  text: string,
  copied: string,
  options: { quiet?: boolean } = {}
): Promise<boolean> {
  return window.api.ui.writeSecretClipboardText(text).then(
    ({ clearsLater }) => {
      if (!clearsLater) {
        toast.success(
          joinSentences([
            `${copied}${sentenceStop(copied)}`,
            translate(
              'bots.webhooks.copiedNoClear',
              'Clear your clipboard when you’re done; this browser can’t promise to clear it for you.'
            )
          ])
        )
      } else if (!options.quiet) {
        toast.success(copied)
      }
      return true
    },
    () => {
      toast.error(translate('bots.webhooks.copyFailed', 'Couldn’t copy. Try again.'))
      return false
    }
  )
}
