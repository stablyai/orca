import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { WebhookHostTarget } from './webhook-host-client'
import { usePendingWebhookSummary } from './use-webhook-data'
import { useWebhookKey } from './use-webhook-key'

/** Copies the hook's whole URL, key included, fetched from its host on click and never shown. With
 *  `onCopied` the caller confirms the copy (`copied`), so no toast. */
export function WebhookCopyUrlButton({
  target,
  hookId,
  botName,
  variant = 'outline',
  copied = false,
  onCopied
}: {
  target: WebhookHostTarget
  hookId: string
  botName: string
  variant?: 'outline' | 'default'
  copied?: boolean
  onCopied?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const key = useWebhookKey({ target, hookId, botName })
  // Until Orca Cloud takes the hook there is no URL; the read polls only until then, so this fills in by itself.
  const read = usePendingWebhookSummary(target, hookId)
  const pending =
    read.status === 'loading' || (read.status === 'ready' && read.value.state === 'pending')
  return (
    <Button
      type="button"
      variant={variant}
      size="xs"
      disabled={pending || key.busy}
      onClick={() =>
        void key.copy('url', { quiet: onCopied !== undefined }).then((done) => {
          if (done) {
            onCopied?.()
          }
        })
      }
    >
      {pending ? (
        t('components.native-chat.automationSaved.gettingUrl', 'Getting the URL…')
      ) : copied ? (
        <>
          <Check aria-hidden />
          {t('bots.webhooks.copied', 'Copied')}
        </>
      ) : (
        t('bots.webhooks.copyUrl', 'Copy URL')
      )}
    </Button>
  )
}
