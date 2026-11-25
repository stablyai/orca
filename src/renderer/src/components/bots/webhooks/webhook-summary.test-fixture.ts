// Hook summaries and calls shaped as the host serves them, for tests and fixture screenshots.
import type {
  WebhookCallRow,
  WebhookSummary
} from '../../../../../shared/rpc-contract/webhooks-params'

export const FIXTURE_HOOK_ID = 'wh_7Kx2pQ9mT4vB8nLc'

export function webhookSummaryFixture(overrides: Partial<WebhookSummary> = {}): WebhookSummary {
  return {
    hookId: FIXTURE_HOOK_ID,
    botId: 'bot-1',
    automationId: 'auto-1',
    state: 'live',
    url: `https://connector.orca.dev/hooks/${FIXTURE_HOOK_ID}`,
    adapter: null,
    lastCall: null,
    host: 'online',
    automationName: 'Investigate Sentry alert',
    resultsTo: 'chat',
    filters: {},
    pendingCalls: 0,
    keyGeneration: 1,
    previousKeyExpiresAt: null,
    ...overrides
  }
}

export function webhookCallsFixture(now: number): WebhookCallRow[] {
  const minutes = (count: number): number => now - count * 60_000
  return [
    {
      kind: 'call',
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      receivedAt: minutes(4),
      state: 'started',
      runId: 'run-12',
      runNumber: 12
    },
    { kind: 'call', callId: 'call_bbbbbbbbbbbbbbbbbbbb', receivedAt: minutes(6), state: 'queued' },
    { kind: 'call', callId: 'call_cccccccccccccccccccc', receivedAt: minutes(8), state: 'ignored' },
    { kind: 'call', callId: 'call_dddddddddddddddddddd', receivedAt: minutes(20), state: 'folded' },
    { kind: 'refused', minute: minutes(200), count: 6 }
  ]
}
