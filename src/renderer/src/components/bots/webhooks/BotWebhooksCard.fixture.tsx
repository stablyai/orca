// The Webhooks page in the Connectors tab at the sidebar's narrowest, a narrow and a wide width.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { WebhookCallRow } from '../../../../../shared/rpc-contract/webhooks-params'
import { openBotConnectorPage } from '../bot-connector-page'
import { clickWhenShown, empty, named, Panel, settle, stub } from '../bot-connectors-host-fixture'
import { webhookCallsFixture, webhookSummaryFixture } from './webhook-summary.test-fixture'

const scout: Bot = { ...empty, id: 'bot-hooks' }

function host(): void {
  const now = Date.now()
  const hook = webhookSummaryFixture({
    botId: scout.id,
    lastCall: { at: now - 4 * 60_000, state: 'started', signatureValid: true }
  })
  // The oldest call is from last year, so its time takes the widest form, with the year.
  const lastYear = new Date(new Date(now).getFullYear() - 1, 11, 28, 12, 47).getTime()
  const calls: WebhookCallRow[] = [
    ...webhookCallsFixture(now).slice(0, 4),
    { kind: 'refused', minute: lastYear, count: 6 }
  ]
  stub({ linearLinked: false, composio: false, bots: [scout], webhooks: { hooks: [hook], calls } })
  openBotConnectorPage(null)
}

// The frame's own inset sits outside the sidebar's width.
const page = (width: number) =>
  defineFixture({
    width: width + 32,
    setup: host,
    render: () => <Panel bot={scout} width={width} />,
    interact: async () => {
      await settle(500)
      await clickWhenShown(named('Webhooks'))
      await settle(250)
      const focused = document.activeElement
      if (focused instanceof HTMLElement) {
        focused.blur()
      }
    }
  })

export const page220 = page(220)
export const page300 = page(300)
export const page420 = page(420)
