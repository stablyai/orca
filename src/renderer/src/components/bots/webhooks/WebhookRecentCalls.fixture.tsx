import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { WebhookCallRow } from '../../../../../shared/rpc-contract/webhooks-params'
import { setWebhookHostTransportForTests } from './webhook-host-client'
import { WebhookRecentCalls } from './WebhookRecentCalls'

const day = (offset: number, hour: number, minute: number): number => {
  const at = new Date()
  at.setDate(at.getDate() + offset)
  at.setHours(hour, minute, 0, 0)
  return at.getTime()
}
const calls: WebhookCallRow[] = [
  { kind: 'call', callId: 'call_a', receivedAt: day(0, 9, 5), state: 'started', runNumber: 12 },
  { kind: 'call', callId: 'call_b', receivedAt: day(-1, 14, 56), state: 'ignored' },
  { kind: 'call', callId: 'call_c', receivedAt: day(-12, 9, 10), state: 'folded' },
  {
    kind: 'refused',
    minute: new Date(new Date().getFullYear() - 1, 10, 14, 14, 56).getTime(),
    count: 6
  }
]

// Calls from today, yesterday, this year and last year share one time column in a narrow pane.
export const days = defineFixture({
  width: 340,
  setup: () =>
    setWebhookHostTransportForTests(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture only renders the calls list, whose one read is webhooks.calls.
      async () => ({ calls }) as never
    ),
  render: () => (
    <WebhookRecentCalls
      target={{ kind: 'local' }}
      hookId="hook-1"
      botName="Scout"
      resultsTo={{ channel: '#alerts' }}
    />
  )
})
