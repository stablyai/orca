import { describe, expect, it } from 'vitest'
import { structuredAgentSessionStatusBlock } from '../agent-session/view/structured-agent-session-status-block'
import {
  connectorOfferBody,
  connectorOfferOf,
  connectorOfferReply,
  signInOfferReply
} from './bot-connector-offer'

describe('a Connect card in a bot chat', () => {
  const body = connectorOfferBody({ botId: 'b1', source: 'slack' }, 'Scout')

  it('survives the wire and draws as a card, its line for older clients', () => {
    const parsed: typeof body = JSON.parse(JSON.stringify(body))
    expect(connectorOfferOf(parsed)).toEqual({ botId: 'b1', source: 'slack' })
    expect(structuredAgentSessionStatusBlock(body)).toMatchObject({
      text: "Scout asks to connect Slack. Connect it from Add connector on Scout's page in Orca on your computer.",
      connectorOffer: { botId: 'b1', source: 'slack' }
    })
  })

  it('names the workspace it adds, and drops an offer this build cannot read', () => {
    expect(
      connectorOfferBody({ botId: 'b1', source: 'linear', workspace: 'Acme' }, 'Scout').text
    ).toContain('Linear (Acme)')
    const gmail = {
      kind: 'status' as const,
      text: 'x',
      connectorOffer: { botId: 'b1', source: 'gmail' }
    }
    expect(connectorOfferOf(gmail)).toBeNull()
  })
})

describe('a Sign in card for a host signed out of Orca', () => {
  const inSlack = { slack: { appId: 'A1', teamId: 'T1' }, linear: null, github: null }

  it('is offered for a connector the bot has, and for webhooks', () => {
    expect(signInOfferReply(inSlack, 'slack', true)?.offered).toBe(true)
    expect(signInOfferReply(inSlack, 'webhook', true)?.offered).toBe(true)
    expect(connectorOfferBody({ botId: 'b1', source: 'webhook', signIn: true }, 'Scout').text).toBe(
      'Webhooks need Orca sign-in. Sign in to Orca on your computer, then tell Scout.'
    )
  })

  it('leaves a missing connector to its Connect card, and signed in offers no Sign in', () => {
    expect(signInOfferReply(inSlack, 'linear', true)).toBeNull()
    expect(signInOfferReply(inSlack, 'slack', false)).toBeNull()
    expect(signInOfferReply(inSlack, 'webhook', false)?.offered).toBe(false)
  })
})

describe('an offer for a connector the bot already has', () => {
  const linked = {
    slack: { appId: 'A1', teamId: 'T1' },
    linear: { workspaceId: 'w1', workspaceName: 'Acme' },
    github: {}
  }

  it('shows the card that adds access, for each account connector, without asking which first', () => {
    for (const source of ['github', 'slack', 'linear'] as const) {
      expect(connectorOfferReply(linked, source, undefined)).toMatchObject({
        offered: true,
        addAccess: true
      })
    }
    // GitHub's install page picks the org itself, so a named one still gets that card.
    expect(connectorOfferReply(linked, 'github', 'stablyai')).toMatchObject({ addAccess: true })
  })

  it('adds a named workspace through its own card, and none for a Linear one it is in', () => {
    expect(connectorOfferReply(linked, 'slack', 'Globex')).toEqual(
      expect.not.objectContaining({ addAccess: true })
    )
    expect(connectorOfferReply(linked, 'linear', 'Acme').offered).toBe(false)
  })
})
