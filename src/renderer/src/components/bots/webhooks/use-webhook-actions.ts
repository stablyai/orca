// The owner's one-click hook actions, shared by the card and the Webhooks row.
import { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { notifyWebhooksChanged } from './use-webhook-data'
import { webhookErrorMessage } from './webhook-copy'
import {
  callWebhookHost,
  newWebhookOperationId,
  webhookErrorCode,
  type WebhookHostTarget
} from './webhook-host-client'

export type WebhookActions = {
  busy: boolean
  sendSample: () => void
  setPaused: (paused: boolean) => void
  remove: () => void
}

export function useWebhookActions(
  target: WebhookHostTarget,
  summary: WebhookSummary,
  botName: string
): WebhookActions {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [busy, setBusy] = useState(false)
  const { hookId } = summary

  const run = async (call: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await call()
      notifyWebhooksChanged()
      toast.success(done)
    } catch (error) {
      toast.error(webhookErrorMessage(webhookErrorCode(error), botName, target))
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    sendSample: () =>
      void run(
        () =>
          callWebhookHost(target, 'webhooks.sample', {
            hookId,
            operationId: newWebhookOperationId()
          }),
        t('bots.webhooks.sample.sent', 'Sample call sent')
      ),
    setPaused: (paused) =>
      void run(
        () => callWebhookHost(target, 'webhooks.pause', { hookId, paused }),
        paused
          ? t('bots.webhooks.paused', 'Webhook paused')
          : t('bots.webhooks.resumed', 'Webhook resumed')
      ),
    remove: () =>
      void confirm({
        ...(summary.deletesAutomation
          ? {
              title: t(
                'bots.webhooks.delete.withAutomation.title',
                'Delete “{{automation}}” and its webhook?',
                { automation: summary.automationName }
              ),
              description: t(
                'bots.webhooks.delete.withAutomation.note',
                "Nothing else starts this automation, so it's deleted with its run history. The webhook's URL stops working, and calls still waiting are cancelled."
              ),
              confirmLabel: t('bots.webhooks.delete.withAutomation.confirm', 'Delete both')
            }
          : {
              title: t('bots.webhooks.delete.title', 'Delete the webhook for “{{automation}}”?', {
                automation: summary.automationName
              }),
              description: t(
                'bots.webhooks.delete.note',
                'Its URL stops working, and calls still waiting are cancelled. A new webhook gets a new URL.'
              ),
              confirmLabel: t('bots.webhooks.delete.confirm', 'Delete webhook')
            }),
        confirmVariant: 'destructive'
      }).then((confirmed) =>
        confirmed
          ? run(
              () => callWebhookHost(target, 'webhooks.delete', { hookId }),
              t('bots.webhooks.delete.done', 'Webhook deleted')
            )
          : undefined
      )
  }
}
