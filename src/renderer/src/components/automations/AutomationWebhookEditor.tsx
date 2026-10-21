import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { WebhookServerEndpoint } from '../../../../shared/automations-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationWebhookSection } from './AutomationWebhookSection'
import { translate } from '@/i18n/i18n'

export function AutomationWebhookEditor({
  localWebhookEndpoint,
  ...props
}: {
  draft: AutomationDraft
  automationId: string | null
  localWebhookEndpoint: boolean
  pickerTriggerClassName: string
  toggleItemClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const [endpoint, setEndpoint] = useState<WebhookServerEndpoint | null>(null)
  useEffect(() => {
    let cancelled = false
    setEndpoint(null)
    if (localWebhookEndpoint) {
      void window.api.automations
        .getWebhookEndpoint()
        .then((value) => {
          if (!cancelled) {
            setEndpoint(value)
          }
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [localWebhookEndpoint, props.automationId])
  const generate = async (): Promise<void> => {
    try {
      const secret = await window.api.automations.generateWebhookSecret()
      props.onDraftChange((draft) => ({ ...draft, webhookSecret: secret }))
    } catch {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.c31810054d',
          'Could not generate a secret.'
        )
      )
    }
  }
  return (
    <AutomationWebhookSection
      {...props}
      webhookEndpoint={localWebhookEndpoint ? endpoint : null}
      remoteHost={!localWebhookEndpoint}
      onGenerateSecret={() => void generate()}
    />
  )
}
