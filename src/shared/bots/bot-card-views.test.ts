import { describe, expect, it } from 'vitest'
import type { BotCardCopyValues } from '../native-chat/bot-cards/bot-card-copy'
import { botCreateOfferTakenOver, botCreateOfferView } from './bot-create-offer-view'
import { botCreateOfferState } from './bot-proposal'
import { botMemoryUpdatedRows } from './bot-memory-updated-note'
import { botRequestCardView } from './bot-request-card-view'
import { webhookCardBodyView, webhookCardShows } from './webhook-card-view'
import type { WebhookSummary } from '../rpc-contract/webhooks-params'
import type { WorkspaceKey } from '../workspace/identity/workspace-scope'

// Names the copy a view picked and its values, so these tests pin the choice, not the wording.
const say = (id: string, values?: BotCardCopyValues): string =>
  values ? `${id} ${JSON.stringify(values)}` : id

describe('bot request card view', () => {
  const card = { toBotId: 'docs', toBotName: 'Docs', purpose: 'question' as const, subject: 'Why?' }
  const unread = { outcome: null, answer: null }

  it('shows a sent question working, then its answer', () => {
    const sent = { ...card, messageId: 'm1' }
    expect(botRequestCardView(sent, unread, 'working', say)).toEqual({
      heading: 'asked',
      line: 'Why?',
      sent: true,
      dot: 'working',
      answer: null,
      copyText: 'Why?'
    })
    expect(botRequestCardView(sent, unread, 'permission', say).dot).toBe('permission')
    const answered = botRequestCardView(sent, { outcome: 'answered', answer: 'Because' }, '', say)
    expect([answered.dot, answered.answer, answered.copyText]).toEqual([
      'done',
      'Because',
      'Why?\n\nBecause'
    ])
  })

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

describe('bot create offer view', () => {
  const proposal = {
    name: 'Cutter',
    purpose: 'Tracks the release.',
    worktrees: [
      { id: 'repo::/w1', name: 'one' },
      { id: 'repo::/w2', name: 'two' }
    ]
  }
  const offer = { botId: 'atlas', offerId: 'o1', proposal, offeredAt: 1 }
  const view = (
    accepted: { offerId: string; botId: string }[],
    bots: { id: string; name: string }[],
    taken: number
  ) => {
    const state = botCreateOfferState(offer, { acceptedOffers: accepted }, bots)
    const created =
      state.kind === 'created' ? bots.find((bot) => bot.id === state.botId) : undefined
    return botCreateOfferView(offer, state, created, taken, say)
  }

  it('offers Edit and Create while open, Rename when the name is taken', () => {
    expect(view([], [], 0)).toEqual({
      createdBotId: null,
      title: 'Cutter',
      line: { kind: 'purpose', text: 'Tracks the release.' },
      open: { note: 'takesOverMany {"count":2}', actions: 'editAndCreate' }
    })
    const taken = view([], [{ id: 'x', name: ' cutter ' }], 0)
    expect(taken.open).toEqual({ note: 'nameTaken {"name":"Cutter"}', actions: 'rename' })
  })

  it('reads Created with how many workspaces it took over, then Deleted once it is gone', () => {
    const accepted = [{ offerId: 'o1', botId: 'b1' }]
    const bots = [{ id: 'b1', name: 'Cutter 2' }]
    expect(view(accepted, bots, 1)).toEqual({
      createdBotId: 'b1',
      title: 'Cutter 2',
      line: { kind: 'created', text: 'createdTookOverSome {"taken":1,"count":2}' },
      open: null
    })
    expect(view(accepted, bots, 0).line.text).toBe('createdAskedMany {"count":2}')
    expect(view(accepted, [], 0)).toMatchObject({
      createdBotId: null,
      line: { kind: 'deleted', text: 'deleted' },
      open: null
    })
  })

  it('counts only the workspaces now under the new bot', () => {
    const parents: Record<string, string> = { 'worktree:repo::/w1': 'folder:home' }
    const parentOf = (child: WorkspaceKey): WorkspaceKey | undefined =>
      parents[child] === 'folder:home' ? 'folder:home' : undefined
    expect(
      botCreateOfferTakenOver({ folderWorkspaceId: 'home' }, proposal.worktrees, parentOf)
    ).toBe(1)
    expect(botCreateOfferTakenOver(undefined, proposal.worktrees, parentOf)).toBe(0)
  })
})

describe('memory updated rows', () => {
  it('lists each change in order, with keys unique among repeats', () => {
    const rows = botMemoryUpdatedRows({
      botId: 'b',
      added: ['tea', 'tea'],
      removed: ['tea'],
      topics: ['notes/a.md'],
      otherChanges: 0
    })
    expect(rows.map((row) => [row.change, row.key])).toEqual([
      ['added', 'tea:1'],
      ['added', 'tea:2'],
      ['removed', 'tea:1'],
      ['noteChanged', 'notes/a.md:1']
    ])
  })
})

describe('webhook card', () => {
  it('draws the card only in the hook bot’s own chat', () => {
    expect(webhookCardShows('ready', 'b1', 'b1')).toBe('card')
    expect(webhookCardShows('ready', 'b2', 'b1')).toBe('elsewhere')
    expect(webhookCardShows('ready', null, 'b1')).toBe('elsewhere')
    expect(webhookCardShows('failed', 'b1', null)).toBe('failed')
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
