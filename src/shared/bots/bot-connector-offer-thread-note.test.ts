import { describe, expect, it } from 'vitest'
import type { ConnectorOffer } from './bot-connector-offer'
import { connectorOfferOpenLine, connectorOfferThreadNote } from './bot-connector-offer-thread-note'

// Orca Cloud's test for a Slack answer that gets the thread's "Open this thread in Orca" link under
// it (orca-cloud connector thread-posts.ts, linkedInstruction). Kept in step by hand.
const CLOUD_LINKED_INSTRUCTION = /\b(?:open|answer|check)[^\n]{0,80}\bOrca\b/i

const SLACK = {
  source: 'slack' as const,
  bot: { kind: 'bot' as const, botId: 'bot-1' },
  place: '#orca'
}
const CONNECT: ConnectorOffer = { botId: 'bot-1', source: 'github' }

const OFFERS: ConnectorOffer[] = [
  CONNECT,
  { botId: 'bot-1', source: 'slack', workspace: 'A very long workspace name '.repeat(7).trim() },
  { botId: 'bot-1', source: 'github', addAccess: true },
  { botId: 'bot-1', source: 'linear', addAccess: true },
  { botId: 'bot-1', source: 'google' },
  { botId: 'bot-1', source: 'slack', signIn: true },
  { botId: 'bot-1', source: 'webhook', signIn: true }
]

describe('connectorOfferOpenLine', () => {
  it("is a line Orca Cloud puts the thread's link under, for every card", () => {
    const lines = [
      ...OFFERS.map((offer) => connectorOfferOpenLine(offer)),
      connectorOfferOpenLine({ botId: 'bot-1', source: 'google' }, { googleAnotherAccount: true })
    ]
    for (const line of lines) {
      expect(line).toMatch(CLOUD_LINKED_INSTRUCTION)
      expect(line).not.toContain('\n')
    }
  })

  it('says what the card is for', () => {
    expect(connectorOfferOpenLine(CONNECT)).toBe('Open Orca to connect GitHub.')
    expect(connectorOfferOpenLine({ botId: 'bot-1', source: 'github', addAccess: true })).toBe(
      'Open Orca to add more GitHub repositories or organizations.'
    )
    expect(connectorOfferOpenLine({ botId: 'bot-1', source: 'slack', addAccess: true })).toBe(
      'Open Orca to add another Slack workspace.'
    )
    expect(connectorOfferOpenLine({ botId: 'bot-1', source: 'linear', signIn: true })).toBe(
      'Open Orca to sign in to Orca Cloud.'
    )
    expect(
      connectorOfferOpenLine({ botId: 'bot-1', source: 'google' }, { googleAnotherAccount: true })
    ).toBe('Open Orca to add another Google account.')
  })
})

describe('connectorOfferThreadNote', () => {
  it('tells the bot the card is only in Orca and how to end its Slack answer', () => {
    const note = connectorOfferThreadNote('bot-1', SLACK, CONNECT)
    expect(note).toContain("not in the Slack thread in #orca, so don't say it is there")
    expect(note).toContain(
      'End it with this line, word for word and in English even if the rest is in another language, and put no table in that message: "Open Orca to connect GitHub."'
    )
    expect(note).toContain(
      "Orca then adds a link to this chat under it, so don't write one yourself."
    )
    expect(note).not.toContain('orca://')
  })

  it("covers the bot's Chat answering a DM", () => {
    const note = connectorOfferThreadNote(
      'bot-1',
      { ...SLACK, bot: { kind: 'bot-chat', botId: 'bot-1' }, place: undefined },
      CONNECT
    )
    expect(note).toContain('not in the Slack conversation that woke you')
  })

  it("points a Linear issue at its session's Open in Orca, in the bot's own words", () => {
    const note = connectorOfferThreadNote(
      'bot-1',
      { ...SLACK, source: 'linear', place: 'ENG-42' },
      CONNECT
    )
    expect(note).toContain('not in ENG-42 on Linear')
    expect(note).toContain('Say in it that the card is waiting in Orca.')
    expect(note).toContain("Linear's agent session on the issue shows Open in Orca")
    expect(note).not.toContain('word for word')
  })

  it('promises no link on GitHub, where Orca Cloud gives none', () => {
    const note = connectorOfferThreadNote(
      'bot-1',
      { ...SLACK, source: 'github', place: 'acme/app#12' },
      CONNECT
    )
    expect(note).toContain('not in acme/app#12 on GitHub')
    expect(note?.endsWith('Say in it that the card is waiting in Orca.')).toBe(true)
  })

  it('adds nothing for a chat no conversation links to this bot', () => {
    expect(connectorOfferThreadNote('bot-1', null, CONNECT)).toBeNull()
    expect(connectorOfferThreadNote('bot-1', { ...SLACK, bot: undefined }, CONNECT)).toBeNull()
    expect(
      connectorOfferThreadNote('bot-1', { ...SLACK, bot: { kind: 'bot', botId: 'bot-2' } }, CONNECT)
    ).toBeNull()
  })
})
