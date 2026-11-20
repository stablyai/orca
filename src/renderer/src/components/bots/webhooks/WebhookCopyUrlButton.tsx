import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { usePendingWebhookSummary } from './use-webhook-data'
import { useWebhookKey } from './use-webhook-key'

/** Copies the hook's whole URL, key included, fetched from its host on click and never shown. */
export function WebhookCopyUrlButton({
  target,
  hookId,
  botName
}: {
  target: RuntimeClientTarget
  hookId: string
  botName: string
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
      variant="outline"
      size="xs"
      disabled={pending || key.busy}
      onClick={() => key.copy('url')}
    >
      {pending
        ? t('components.native-chat.automationSaved.gettingUrl', 'Getting the URL…')
        : t('bots.webhooks.copyUrl', 'Copy URL')}
    </Button>
  )
}
