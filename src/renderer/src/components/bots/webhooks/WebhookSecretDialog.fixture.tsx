import { defineFixture } from '../../../component-fixtures/component-fixture'
import { WebhookSecretDialog } from './WebhookSecretDialog'
import { webhookSummaryFixture } from './webhook-summary.test-fixture'

function dialog(adapter: 'github' | null): React.JSX.Element {
  return (
    <WebhookSecretDialog
      target={{ kind: 'local' }}
      summary={webhookSummaryFixture({ adapter, automationName: 'Reply to customer emails' })}
      botName="Scout"
      open
      onOpenChange={() => {}}
    />
  )
}

// Standard Webhooks: "Orca makes one" by default; "Paste the sender's" is one click away.
export const standard = defineFixture({ width: 640, render: () => dialog(null) })

export const github = defineFixture({ width: 640, render: () => dialog('github') })
