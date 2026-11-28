import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { BOT_SHARE_ERRORS } from '../../../../../shared/bots/bot-share-errors'
import type * as BotShareRpc from './bot-share-rpc'
import { updateBotShareInPlace } from './bot-share-update-in-place'
import type { BotShareLink } from './use-bot-share-link'

const { prepareBotShare, updateBotShare } = vi.hoisted(() => ({
  prepareBotShare: vi.fn(),
  updateBotShare: vi.fn()
}))
vi.mock('./bot-share-rpc', async (original) => ({
  ...(await original<typeof BotShareRpc>()),
  prepareBotShare,
  updateBotShare
}))

const bot = { id: 'b1', hostId: 'local' } as const
const LINK: BotShareLink = {
  shareId: 'share-1',
  url: 'https://orca.example/s/1',
  versionId: 'v1',
  updatedAt: '2026-11-20T00:00:00.000Z',
  digest: 'digest-v1'
}

function candidate(digest: string, flags: { kind: string }[] = []): BotShareCandidateSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update reads only these fields.
  return {
    candidateId: 'cand-1',
    botDigest: digest,
    flags,
    bot: { setupNote: 'Connect Slack' }
  } as unknown as BotShareCandidateSummary
}

beforeEach(() => {
  prepareBotShare.mockReset()
  updateBotShare.mockReset()
})

describe('Update link in place', () => {
  it('sends the bot as it is now with its last picks and note, to the same link', async () => {
    prepareBotShare.mockResolvedValue({
      candidate: candidate('digest-v2'),
      last: { selection: { memory: ['people'] }, setupNote: 'Connect Slack' }
    })
    updateBotShare.mockResolvedValue({
      share: { id: 'share-1', url: LINK.url, pinnedVersionId: 'v2' },
      version: { versionId: 'v2', packageDigest: 'digest-v2' }
    })
    const result = await updateBotShareInPlace(bot, LINK)
    expect(prepareBotShare.mock.calls[0]?.[2]).toMatchObject({ last: true })
    expect(updateBotShare).toHaveBeenCalledWith(bot, 'cand-1', 'Connect Slack', {
      shareId: 'share-1',
      expectedVersionId: 'v1'
    })
    expect(result).toMatchObject({
      kind: 'updated',
      link: { shareId: 'share-1', versionId: 'v2', digest: 'digest-v2' }
    })
  })

  it('publishes nothing when a secret is found, so the dialog can show it', async () => {
    prepareBotShare.mockResolvedValue({
      candidate: candidate('digest-v2', [{ kind: 'secret' }]),
      last: { selection: {}, setupNote: 'Connect Slack' }
    })
    expect(await updateBotShareInPlace(bot, LINK)).toEqual({ kind: 'secret' })
    expect(updateBotShare).not.toHaveBeenCalled()
  })

  it('publishes nothing when the bot and note are unchanged', async () => {
    prepareBotShare.mockResolvedValue({
      candidate: candidate('digest-v1'),
      last: { selection: {}, setupNote: 'Connect Slack' }
    })
    expect(await updateBotShareInPlace(bot, LINK)).toEqual({ kind: 'upToDate' })
    expect(updateBotShare).not.toHaveBeenCalled()
  })

  it('asks for a fresh read when the link was stopped elsewhere', async () => {
    prepareBotShare.mockResolvedValue({
      candidate: candidate('digest-v2'),
      last: { selection: {}, setupNote: 'Connect Slack' }
    })
    updateBotShare.mockRejectedValue(new Error(BOT_SHARE_ERRORS.stopped))
    expect(await updateBotShareInPlace(bot, LINK)).toMatchObject({ kind: 'failed', stale: true })
  })
})
