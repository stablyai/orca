import { describe, expect, it } from 'vitest'
import type { BotCardCopyValues } from '../native-chat/bot-cards/bot-card-copy'
import { botRequestCardView } from './bot-request-card-view'
import { webhookCardBodyView } from './webhook-card-view'
import type { WebhookSummary } from '../rpc-contract/webhooks-params'

// Names the copy a view picked and its values, so these tests pin the choice, not the wording.
const say = (id: string, values?: BotCardCopyValues): string =>
  values ? `${id} ${JSON.stringify(values)}` : id

describe('bot request card view', () => {
  const card = { toBotId: 'docs', toBotName: 'Docs', purpose: 'question' as const, subject: 'Why?' }
  const unread = { outcome: null, answer: null }

  it('keeps no dot on a handoff the bot kept, and marks an unanswered question', () => {
    const handoff = { ...card, purpose: 'handoff' as const, messageId: 'm1' }
    const left = { outcome: 'unanswered' as const, answer: null }
    expect(botRequestCardView(handoff, left, '', say)).toMatchObject({
      heading: 'handedTo',
      dot: null
    })
    expect(botRequestCardView({ ...card, messageId: 'm1' }, left, '', say).dot).toBe('interrupted')
  })

  it('says why a request was not sent, by refusal code', () => {
    const view = botRequestCardView({ ...card, refusal: 'bot_paused' }, unread, 'working', say)
    expect(view).toMatchObject({
      heading: 'notSentTo',
      line: 'paused {"bot":"Docs"}',
      sent: false,
      dot: null
    })
    expect(botRequestCardView({ ...card, refusal: 'constructor' }, unread, '', say).line).toBe(
      'couldNotTake {"bot":"Docs"}'
    )
  })
})

describe('webhook card body', () => {
  const summary: WebhookSummary = {
    hookId: 'wh_1',
    botId: 'b1',
    automationId: 'a1',
    state: 'live',
    url: 'https://hooks.example/wh_1',
    adapter: 'github',
    lastCall: { at: 50, state: 'started', signatureValid: true },
    host: 'online',
    automationName: 'Triage',
    resultsTo: 'chat',
    filters: {},
    pendingCalls: 0,
    keyGeneration: 1,
    previousKeyExpiresAt: null
  }
  const body = (patch: Partial<WebhookSummary>, local = { refreshFailed: false, busy: false }) =>
    webhookCardBodyView({ ...summary, ...patch }, local, say)

  it('offers the secret and a sample only while the host can act on a live hook', () => {
    expect(body({})).toMatchObject({
      status: { kind: 'lastCall', at: 50, signedBy: 'github', tone: 'connected' },
      hostReady: true,
      secret: { label: 'secretChange {"sender":"GitHub"}', enabled: true },
      sample: { enabled: true }
    })
    expect(body({ state: 'paused' })).toMatchObject({
      status: { kind: 'paused' },
      secret: { enabled: true },
      sample: { enabled: false }
    })
    expect(body({ host: 'offline', adapter: null })).toMatchObject({
      hostReady: false,
      secret: { label: 'secretAdd', enabled: false },
      sample: { enabled: false }
    })
    expect(body({}, { refreshFailed: true, busy: false }).hostReady).toBe(false)
    expect(body({}, { refreshFailed: false, busy: true }).sample.enabled).toBe(false)
  })

  it('says a call was signed only when the cloud checked its signature', () => {
    expect(body({ lastCall: { at: 50, state: 'started', signatureValid: false } }).status).toEqual({
      kind: 'lastCall',
      at: 50,
      signedBy: null,
      tone: 'connected'
    })
    expect(body({ lastCall: null }).status).toEqual({ kind: 'noCalls', tone: 'neutral' })
  })
})
