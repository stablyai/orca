import React from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  AutomationWebhookSecretMode,
  WebhookServerEndpoint
} from '../../../../shared/automations-types'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { translate } from '@/i18n/i18n'

type AutomationWebhookSectionProps = {
  draft: AutomationDraft
  automationId: string | null
  webhookEndpoint: WebhookServerEndpoint | null
  pickerTriggerClassName: string
  toggleItemClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onGenerateSecret: () => void
}

/** Builds the URL a Git provider should POST to, or a reason it isn't ready. */
function resolveWebhookUrl(
  endpoint: WebhookServerEndpoint | null,
  automationId: string | null
): { url: string | null; hint: string } {
  if (!automationId) {
    return { url: null, hint: 'Save the automation to get its webhook URL.' }
  }
  if (!endpoint || !endpoint.running) {
    return {
      url: null,
      hint: 'Enable the webhook receiver in Settings → Automations to get a URL.'
    }
  }
  // Why: a 0.0.0.0 bind has no usable host in a URL; show a placeholder the
  // user replaces with the machine's reachable address/hostname.
  const host = endpoint.bindAddress === '0.0.0.0' ? 'YOUR-HOST' : endpoint.bindAddress
  return {
    url: `http://${host}:${endpoint.port}/webhook/${automationId}`,
    hint:
      endpoint.bindAddress === '0.0.0.0'
        ? 'Replace YOUR-HOST with this machine’s address reachable by the sender.'
        : 'Point your provider’s webhook at this URL (POST).'
  }
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(
      translate(
        'auto.components.automations.AutomationWebhookSection.a3bd440808',
        'Copied to clipboard.'
      )
    )
  } catch {
    toast.error(
      translate(
        'auto.components.automations.AutomationWebhookSection.8bf8cbbbbd',
        'Could not copy to clipboard.'
      )
    )
  }
}

export function AutomationWebhookSection({
  draft,
  automationId,
  webhookEndpoint,
  pickerTriggerClassName,
  toggleItemClassName,
  onDraftChange,
  onGenerateSecret
}: AutomationWebhookSectionProps): React.JSX.Element {
  const { url, hint } = resolveWebhookUrl(webhookEndpoint, automationId)
  const showSecret = draft.webhookSecretMode !== 'none'

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border p-3">
      <Field
        label={translate(
          'auto.components.automations.AutomationWebhookSection.3a6a84f68c',
          'Webhook trigger'
        )}
      >
        <ToggleGroup
          type="single"
          value={draft.webhookEnabled ? 'on' : 'off'}
          onValueChange={(value) => {
            if (!value) {
              return
            }
            onDraftChange((current) => ({ ...current, webhookEnabled: value === 'on' }))
          }}
          variant="outline"
          size="sm"
          className="grid w-full grid-cols-2"
        >
          <ToggleGroupItem value="off" className={toggleItemClassName}>
            {translate('auto.components.automations.AutomationWebhookSection.dad1ed1360', 'Off')}
          </ToggleGroupItem>
          <ToggleGroupItem value="on" className={toggleItemClassName}>
            {translate('auto.components.automations.AutomationWebhookSection.c56469bd09', 'On')}
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationWebhookSection.3e0c1dbf7b',
            'An incoming POST runs this automation with the request body appended to the prompt.'
          )}
        </p>
      </Field>

      {draft.webhookEnabled ? (
        <>
          <Field
            label={translate(
              'auto.components.automations.AutomationWebhookSection.2ece8e0bc1',
              'Webhook URL'
            )}
          >
            <div className="flex items-center gap-2">
              <Input readOnly value={url ?? ''} placeholder={hint} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={!url}
                aria-label={translate(
                  'auto.components.automations.AutomationWebhookSection.5ef250560e',
                  'Copy webhook URL'
                )}
                onClick={() => {
                  if (url) {
                    void copyToClipboard(url)
                  }
                }}
              >
                <Copy />
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </Field>

          <Field
            label={translate(
              'auto.components.automations.AutomationWebhookSection.b638783b07',
              'Verification'
            )}
          >
            <Select
              value={draft.webhookSecretMode}
              onValueChange={(value) =>
                onDraftChange((current) => ({
                  ...current,
                  webhookSecretMode: value as AutomationWebhookSecretMode
                }))
              }
            >
              <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
                <SelectItem value="none">
                  {translate(
                    'auto.components.automations.AutomationWebhookSection.ae89a70e09',
                    'No verification'
                  )}
                </SelectItem>
                <SelectItem value="token">
                  {translate(
                    'auto.components.automations.AutomationWebhookSection.8691ec4306',
                    'Shared token (e.g. GitLab)'
                  )}
                </SelectItem>
                <SelectItem value="hmac_sha256">
                  {translate(
                    'auto.components.automations.AutomationWebhookSection.ef7a29878b',
                    'HMAC SHA-256 (e.g. GitHub, Gitea)'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {!showSecret &&
          webhookEndpoint?.running &&
          webhookEndpoint.bindAddress !== '127.0.0.1' ? (
            <p className="text-xs text-destructive">
              {translate(
                'auto.components.automations.AutomationWebhookSection.f9cc4a7f5e',
                'With no verification, anyone who learns this URL can trigger the automation. The receiver is bound to a non-local address — set a token or HMAC secret.'
              )}
            </p>
          ) : null}

          {showSecret ? (
            <Field
              label={translate(
                'auto.components.automations.AutomationWebhookSection.800e24053b',
                'Secret'
              )}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={draft.webhookSecret}
                  placeholder={translate(
                    'auto.components.automations.AutomationWebhookSection.0edb757986',
                    'Shared secret'
                  )}
                  className="font-mono text-xs"
                  onChange={(event) =>
                    onDraftChange((current) => ({ ...current, webhookSecret: event.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.automations.AutomationWebhookSection.9ebd9e13cd',
                    'Generate a new secret'
                  )}
                  onClick={onGenerateSecret}
                >
                  <RefreshCw />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={!draft.webhookSecret}
                  aria-label={translate(
                    'auto.components.automations.AutomationWebhookSection.fee8c4240e',
                    'Copy secret'
                  )}
                  onClick={() => {
                    if (draft.webhookSecret) {
                      void copyToClipboard(draft.webhookSecret)
                    }
                  }}
                >
                  <Copy />
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.webhookSecretMode === 'token'
                  ? translate(
                      'auto.components.automations.AutomationWebhookSection.e501cb7525',
                      'Sent by the provider as a token header (X-Gitlab-Token or X-Webhook-Token).'
                    )
                  : translate(
                      'auto.components.automations.AutomationWebhookSection.684540740d',
                      'Used to verify the request body signature (X-Hub-Signature-256 / X-Gitea-Signature).'
                    )}
              </p>
            </Field>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
