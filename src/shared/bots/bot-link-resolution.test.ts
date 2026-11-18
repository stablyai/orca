import { describe, expect, it } from 'vitest'
import {
  redeemOnFirstHost,
  resolveAccessRequestNotHere,
  resolveBotLink,
  type AccessRequestRedeemOutcome,
  type BotLinkHostAnswer
} from './bot-link-resolution'

const atlas = { id: 'atlas', name: 'Atlas', folderWorkspaceId: 'home-1' }
const scout = { id: 'scout', name: 'Scout', folderWorkspaceId: 'home-2' }

function bots(hostId: string, list: (typeof atlas)[]): BotLinkHostAnswer {
  return { hostId, answer: { kind: 'bots', bots: list } }
}

describe('resolveBotLink', () => {
  it('opens the one host that lists the bot', () => {
    expect(resolveBotLink('atlas', [bots('mac', [scout]), bots('box', [atlas])])).toEqual({
      kind: 'open',
      match: { hostId: 'box', bot: atlas }
    })
  })

  it('offers a choice when two hosts claim the same id, in host order', () => {
    expect(resolveBotLink('atlas', [bots('mac', [atlas]), bots('box', [atlas])])).toEqual({
      kind: 'pick',
      matches: [
        { hostId: 'mac', bot: atlas },
        { hostId: 'box', bot: atlas }
      ]
    })
  })

  it('still opens a listed bot when another host is too old to answer', () => {
    expect(
      resolveBotLink('atlas', [
        { hostId: 'old', answer: { kind: 'no-capability' } },
        bots('mac', [atlas])
      ])
    ).toMatchObject({ kind: 'open', match: { hostId: 'mac' } })
  })

  it('asks for an update when only hosts too old to list bots could have it', () => {
    expect(
      resolveBotLink('atlas', [
        bots('mac', [scout]),
        { hostId: 'old', answer: { kind: 'no-capability' } }
      ])
    ).toEqual({ kind: 'update-needed', hostIds: ['old'] })
  })

  it('names the silent hosts before asking an old one to update', () => {
    expect(
      resolveBotLink('atlas', [
        { hostId: 'old', answer: { kind: 'no-capability' } },
        { hostId: 'away', answer: { kind: 'unreachable' } },
        { hostId: 'garbled', answer: { kind: 'unreadable' } }
      ])
    ).toEqual({ kind: 'unreachable', hostIds: ['away', 'garbled'] })
  })

  it('says the bot is missing once every host answered without it', () => {
    expect(resolveBotLink('atlas', [bots('mac', [scout])])).toEqual({ kind: 'missing' })
    expect(resolveBotLink('atlas', [])).toEqual({ kind: 'missing' })
  })
})

describe('redeemOnFirstHost', () => {
  function redeemer(outcomes: Record<string, AccessRequestRedeemOutcome>) {
    const tried: string[] = []
    return {
      tried,
      redeem: (hostId: string) => {
        tried.push(hostId)
        return Promise.resolve(outcomes[hostId])
      }
    }
  }

  it('stops at the first host that takes the token', async () => {
    const { tried, redeem } = redeemer({
      a: { kind: 'not-owner' },
      b: { kind: 'redeemed', botId: 'atlas' },
      c: { kind: 'redeemed', botId: 'atlas' }
    })
    await expect(redeemOnFirstHost(['a', 'b', 'c'], redeem)).resolves.toEqual({
      kind: 'redeemed',
      hostId: 'b',
      botId: 'atlas'
    })
    expect(tried).toEqual(['a', 'b'])
  })

  it('moves past a host without the request’s bot, which leaves the token unspent', async () => {
    const { tried, redeem } = redeemer({
      a: { kind: 'not-here' },
      b: { kind: 'redeemed', botId: 'atlas' }
    })
    await expect(redeemOnFirstHost(['a', 'b'], redeem)).resolves.toEqual({
      kind: 'redeemed',
      hostId: 'b',
      botId: 'atlas'
    })
    expect(tried).toEqual(['a', 'b'])
  })

  it('says the bot isn’t here when every host answered not-here', async () => {
    await expect(
      redeemOnFirstHost(
        ['a', 'b'],
        redeemer({ a: { kind: 'not-here' }, b: { kind: 'not-here' } }).redeem
      )
    ).resolves.toEqual({ kind: 'not-here' })
  })

  it('answers wrong account only when the cloud said so', async () => {
    await expect(
      redeemOnFirstHost(
        ['a', 'b'],
        redeemer({ a: { kind: 'not-here' }, b: { kind: 'not-owner' } }).redeem
      )
    ).resolves.toEqual({ kind: 'not-owner' })
  })

  it('stops once the token is spent', async () => {
    const { tried, redeem } = redeemer({ a: { kind: 'expired' }, b: { kind: 'not-owner' } })
    await expect(redeemOnFirstHost(['a', 'b'], redeem)).resolves.toEqual({ kind: 'expired' })
    expect(tried).toEqual(['a'])
  })

  it('reports the most useful refusal when no host takes it', async () => {
    await expect(
      redeemOnFirstHost(
        ['a', 'b'],
        redeemer({ a: { kind: 'unsupported' }, b: { kind: 'not-owner' } }).redeem
      )
    ).resolves.toEqual({ kind: 'not-owner' })
    await expect(
      redeemOnFirstHost(
        ['a', 'b'],
        redeemer({ a: { kind: 'failed' }, b: { kind: 'not-owner' } }).redeem
      )
    ).resolves.toEqual({ kind: 'failed' })
    await expect(redeemOnFirstHost([], redeemer({}).redeem)).resolves.toEqual({
      kind: 'unsupported'
    })
  })
})

describe('resolveAccessRequestNotHere', () => {
  it('says no paired computer has the bot when every host answered', () => {
    expect(resolveAccessRequestNotHere([bots('mac', [scout])])).toEqual({ kind: 'missing' })
  })

  it('names the hosts that never answered, which may have the bot', () => {
    expect(
      resolveAccessRequestNotHere([
        bots('mac', [scout]),
        { hostId: 'away', answer: { kind: 'unreachable' } },
        { hostId: 'old', answer: { kind: 'no-capability' } }
      ])
    ).toEqual({ kind: 'unreachable', hostIds: ['away'] })
  })
})
