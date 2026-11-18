import { describe, expect, it } from 'vitest'
import { soulDescription } from '../bot-soul'
import { BotCreate } from '../rpc-contract/bots-params'
import {
  botCreateOfferState,
  proposalSoul,
  templateProposal,
  proposalCreateParams,
  withAcceptedOffer
} from './bot-proposal'
import { botTemplate } from './bot-templates'

describe('a proposed bot', () => {
  it('seeds SOUL.md with its purpose first, how it works, and read-only to start', () => {
    const soul = proposalSoul('Milo', {
      purpose: 'Keeps a list of questions nobody has answered.',
      watches: 'support-replies, faq-updates · Linear team Support',
      reports: 'Here, every 2 hours on weekdays',
      templateId: 'support'
    })
    expect(soul).toBe(`# Milo

Keeps a list of questions nobody has answered.

## How I work

- Watches: support-replies, faq-updates · Linear team Support
- Reports: Here, every 2 hours on weekdays
- Started from the Support triage template.

## Never

- Change anything (comments, labels, pull requests, posts anywhere but here) until my owner says I can. I start by reading and reporting only.
`)
    // `bot list` reads what it is for.
    expect(soulDescription(soul)).toBe('Keeps a list of questions nobody has answered.')
  })

  it('makes one bots.create request a host accepts, taking over its workspaces', () => {
    const template = botTemplate('feedback')!
    const params = proposalCreateParams(
      templateProposal(template, {
        name: ' Echo ',
        mascot: 'B1',
        worktrees: [{ id: 'w9', name: 'feedback-tagging' }]
      }),
      'claude',
      { templatePackages: true, skills: [] }
    )
    expect(params).toEqual({
      name: 'Echo',
      agent: 'claude',
      avatar: 'mascot:B1',
      handOff: [{ id: 'w9', name: 'feedback-tagging' }],
      seed: {
        purpose: 'Turns feedback into a weekly list of themes.',
        watches: 'Slack feedback channels',
        does: 'Group feedback into themes with quotes and counts. Link existing Linear issues.',
        reports: 'Here, Mondays at 9 AM',
        templateId: 'feedback'
      },
      fromTemplate: { id: 'feedback', skills: [] }
    })
    expect(BotCreate.safeParse(params).success).toBe(true)
  })

  it('sends an older host only what its enum takes: the seed, and an old template id', () => {
    const fresh = proposalCreateParams(templateProposal(botTemplate('pr-review')!), 'claude', {
      templatePackages: false
    })
    expect(fresh.fromTemplate).toBeUndefined()
    expect(fresh.seed?.templateId).toBeUndefined()
    expect(fresh.name).toBe('Pull request review')
    const old = proposalCreateParams(templateProposal(botTemplate('support')!), 'claude', {
      templatePackages: false
    })
    expect(old.fromTemplate).toBeUndefined()
    expect(old.seed?.templateId).toBe('support')
  })

  it('keeps every card it accepted, however many, so an old card never opens again', () => {
    let proposer: { acceptedOffers?: { offerId: string; botId: string }[] } = {}
    for (let index = 1; index <= 150; index++) {
      proposer = { acceptedOffers: withAcceptedOffer(proposer, `offer-${index}`, `bot-${index}`) }
    }
    expect(
      botCreateOfferState(
        { offerId: 'offer-1', proposal: { name: 'Cutter', purpose: 'Track release' } },
        proposer,
        [{ id: 'bot-1', name: 'Release' }]
      )
    ).toEqual({ kind: 'created', botId: 'bot-1' })
  })
})
