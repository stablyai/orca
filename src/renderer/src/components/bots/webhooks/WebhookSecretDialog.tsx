import React, { useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'
import {
  WEBHOOK_ADAPTERS,
  type WebhookAdapterId
} from '../../../../../shared/connector-webhook-contract'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { notifyWebhooksChanged } from './use-webhook-data'
import { webhookErrorMessage } from './webhook-copy'
import {
  webhookAdapterGeneratesSecret,
  webhookAdapterName,
  webhookAdapterTakesPastedSecret
} from '../../../../../shared/bots/webhook-card-view'
import { callWebhookHost, newWebhookOperationId, webhookErrorCode } from './webhook-host-client'
import { copyWebhookSecret } from './webhook-secret-copy'

/** Add signing secret / Change…: pick the sender, then paste its secret or have Orca make one. */
export function WebhookSecretDialog({
  target,
  summary,
  botName,
  open,
  onOpenChange
}: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  botName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted per opening, so a pasted secret never outlives the dialog. */}
        {open ? (
          <SecretForm
            target={target}
            summary={summary}
            botName={botName}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SecretForm({
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
  const [adapter, setAdapter] = useState<WebhookAdapterId>(summary.adapter ?? 'standard')
  const [secret, setSecret] = useState('')
  const [mode, setMode] = useState<'generate' | 'paste'>('generate')
  const [saving, setSaving] = useState(false)
  // A generated secret is copied, never shown, then kept only until the dialog closes.
  const [generated, setGenerated] = useState<string | null>(null)
  const choosesMode =
    webhookAdapterGeneratesSecret(adapter) && webhookAdapterTakesPastedSecret(adapter)
  const generates = webhookAdapterGeneratesSecret(adapter) && (!choosesMode || mode === 'generate')
  const sender = webhookAdapterName(adapter)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await callWebhookHost(target, 'webhooks.secret', {
        hookId: summary.hookId,
        operationId: newWebhookOperationId(),
        adapter,
        ...(generates ? { generate: true as const } : { secret: secret.trim() })
      })
      notifyWebhooksChanged()
      if (generates && result.secret) {
        setGenerated(result.secret)
        return
      }
      toast.success(t('bots.webhooks.secret.saved', 'Signing secret saved'))
      onDone()
    } catch (error) {
      toast.error(webhookErrorMessage(webhookErrorCode(error), botName, target))
    } finally {
      setSaving(false)
    }
  }

  if (generated !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t('bots.webhooks.secret.generatedTitle', 'Signing secret ready')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'bots.webhooks.secret.generatedNote',
              'Copy it into {{sender}}’s webhook settings. From now on, calls must carry its signature.',
              { sender }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            {t('bots.webhooks.secret.done', 'Done')}
          </Button>
          <Button
            onClick={() =>
              void copyWebhookSecret(generated, t('bots.webhooks.secret.copied', 'Secret copied'))
            }
          >
            {t('bots.webhooks.secret.copy', 'Copy secret')}
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {summary.adapter
            ? t('bots.webhooks.secret.changeTitle', 'Change signing secret')
            : t('bots.webhooks.secret.addTitle', 'Add signing secret')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'bots.webhooks.secret.note',
            'Orca then accepts only calls signed with this secret, so a leaked URL alone can’t start “{{automation}}”.',
            { automation: summary.automationName }
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="webhook-secret-sender">
            {t('bots.webhooks.secret.sender', 'Sender')}
          </Label>
          <Select
            value={adapter}
            onValueChange={(value) => {
              const next = WEBHOOK_ADAPTERS.find((candidate) => candidate === value)
              if (next) {
                setAdapter(next)
              }
            }}
          >
            <SelectTrigger id="webhook-secret-sender" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEBHOOK_ADAPTERS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {webhookAdapterName(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {choosesMode ? (
          <ToggleGroup
            role="radiogroup"
            aria-label={t('bots.webhooks.secret.mode', 'Where the secret comes from')}
            type="single"
            spacing={1}
            size="sm"
            variant="segmented-card"
            value={mode}
            onValueChange={(value) => {
              if (value === 'generate' || value === 'paste') {
                setMode(value)
              }
            }}
          >
            <ToggleGroupItem role="radio" aria-checked={mode === 'generate'} value="generate">
              {t('bots.webhooks.secret.modeGenerate', 'Orca makes one')}
            </ToggleGroupItem>
            <ToggleGroupItem role="radio" aria-checked={mode === 'paste'} value="paste">
              {t('bots.webhooks.secret.modePaste', 'Paste the sender’s')}
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {generates ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.webhooks.secret.generateNote',
              'Orca makes this secret. You copy it into {{sender}} next.',
              { sender }
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webhook-secret-value">
              {t('bots.webhooks.secret.paste', '{{sender}} secret', { sender })}
            </Label>
            <Input
              id="webhook-secret-value"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            {choosesMode ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  'bots.webhooks.secret.pasteNote',
                  'Use this when the sender gives you its own secret.'
                )}
              </p>
            ) : null}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('bots.webhooks.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={saving || (!generates && secret.trim().length === 0)}>
          {generates
            ? t('bots.webhooks.secret.generate', 'Generate secret')
            : t('bots.webhooks.secret.save', 'Save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
