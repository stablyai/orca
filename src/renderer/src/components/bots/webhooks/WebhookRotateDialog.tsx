import React, { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { notifyWebhooksChanged } from './use-webhook-data'
import { webhookErrorMessage } from './webhook-copy'
import { callWebhookHost, newWebhookOperationId, webhookErrorCode } from './webhook-host-client'

type OldKey = 'overlap' | 'stop'

function RotateChoice(props: { value: OldKey; title: string; note: string }): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <RadioGroupItem id={id} value={props.value} className="mt-0.5" />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{props.title}</Label>
        <p className="text-xs text-muted-foreground">{props.note}</p>
      </div>
    </div>
  )
}

/** Rotate key…: a new key, with the old one either kept a while or stopped now. */
export function WebhookRotateDialog(props: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  botName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted per opening, so every opening starts on keeping the old key. */}
        {props.open ? <RotateForm {...props} onDone={() => props.onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function RotateForm({
  target,
  summary,
  botName,
  onDone
}: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  botName: string
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [oldKey, setOldKey] = useState<OldKey>('overlap')
  const [rotating, setRotating] = useState(false)
  const rotate = async (): Promise<void> => {
    setRotating(true)
    try {
      await callWebhookHost(target, 'webhooks.rotate', {
        hookId: summary.hookId,
        operationId: newWebhookOperationId(),
        stopNow: oldKey === 'stop'
      })
      notifyWebhooksChanged()
      toast.success(t('bots.webhooks.rotate.done', 'Key rotated. Copy the new URL.'))
      onDone()
    } catch (error) {
      toast.error(webhookErrorMessage(webhookErrorCode(error), botName, target))
    } finally {
      setRotating(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('bots.webhooks.rotate.title', 'Rotate the key for “{{automation}}”?', {
            automation: summary.automationName
          })}
        </DialogTitle>
        <DialogDescription>
          {t('bots.webhooks.rotate.note', 'The URL gets a new key. Update every sender with it.')}
        </DialogDescription>
      </DialogHeader>
      <RadioGroup
        value={oldKey}
        onValueChange={(value) => setOldKey(value === 'stop' ? 'stop' : 'overlap')}
      >
        <RotateChoice
          value="overlap"
          title={t('bots.webhooks.rotate.overlap', 'Keep the old key working for 24 hours')}
          note={t(
            'bots.webhooks.rotate.overlapNote',
            'Senders keep working while you update them.'
          )}
        />
        <RotateChoice
          value="stop"
          title={t('bots.webhooks.rotate.stop', 'Stop the old key now')}
          note={
            summary.pendingCalls > 0
              ? t(
                  'bots.webhooks.rotate.stopCancels',
                  'For a leaked key. {{count}} waiting calls it let in are cancelled.',
                  {
                    count: summary.pendingCalls,
                    defaultValue_one:
                      'For a leaked key. {{count}} waiting call it let in is cancelled.'
                  }
                )
              : t('bots.webhooks.rotate.stopNote', 'For a leaked key.')
          }
        />
      </RadioGroup>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          {t('bots.webhooks.cancel', 'Cancel')}
        </Button>
        <Button
          variant={oldKey === 'stop' ? 'destructive' : 'default'}
          disabled={rotating}
          onClick={() => void rotate()}
        >
          {t('bots.webhooks.rotate.confirm', 'Rotate key')}
        </Button>
      </DialogFooter>
    </>
  )
}
