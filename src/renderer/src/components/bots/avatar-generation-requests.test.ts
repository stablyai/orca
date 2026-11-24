// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { AvatarGenerationResult } from '../../../../shared/avatar-generation/avatar-generation-contract'

const mocks = vi.hoisted(() => ({
  uploadBotAvatar: vi.fn(),
  readHostBots: vi.fn((): Bot[] => []),
  botHostHas: vi.fn(() => true),
  keepSavedPictureDescription: vi.fn(),
  toastError: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(async () => {})
}))

vi.mock('@/lib/bot-catalog', () => ({
  readBotGenerationRevision: async (_ref: unknown, revision: number) => revision,
  uploadBotAvatar: mocks.uploadBotAvatar,
  readHostBots: mocks.readHostBots
}))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: mocks.botHostHas }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
// The real crop draws on a canvas, which happy-dom lacks.
vi.mock('./bot-avatar-intake', () => ({ avatarPngFromBlob: async () => 'CROPPED' }))
vi.mock('./avatar-generation-capability-store', () => ({
  avatarGenerationApi: () => ({ generate: mocks.generate, cancel: mocks.cancel }),
  setAvatarAgentStatus: vi.fn()
}))
vi.mock('./generated-avatar-descriptions', () => ({
  keepSavedPictureDescription: mocks.keepSavedPictureDescription,
  rememberGeneratedPicture: vi.fn()
}))

import {
  cancelAvatarRequest,
  handOffAvatarRequest,
  releaseAvatarRequest,
  resetAvatarRequestsForTests,
  startAvatarRequest,
  type AvatarRequestHost
} from './avatar-generation-requests'
import {
  beginBotPictureOp,
  noteBotPictureAck,
  noteBotPictureChoice,
  noteBotPictureFailure
} from './bot-picture-ops'

const IMAGE = { mimeType: 'image/png', base64: 'AAAA' }
const BOT_KEY = 'local\u0000b1'

function bot(overrides: Partial<Bot> = {}): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only id, hostId, name and avatarRevision.
  return { id: 'b1', hostId: 'local', name: 'Scout', avatar: 'mascot:A1', ...overrides } as Bot
}

/** The next run's outcome, settled by the test. */
function nextRun(): (outcome: AvatarGenerationResult) => Promise<void> {
  let resolve: (outcome: AvatarGenerationResult) => void = () => {}
  mocks.generate.mockImplementationOnce(
    () => new Promise<AvatarGenerationResult>((done) => (resolve = done))
  )
  return async (outcome) => {
    resolve(outcome)
    await vi.waitFor(() => undefined)
    await new Promise((done) => setTimeout(done, 0))
  }
}

const made: AvatarGenerationResult = { ok: true, agent: 'codex', image: IMAGE }

function host() {
  return {
    landed: vi.fn<AvatarRequestHost['landed']>(),
    failed: vi.fn<AvatarRequestHost['failed']>(),
    ended: vi.fn<AvatarRequestHost['ended']>()
  }
}

function startFor(owner: Parameters<typeof startAvatarRequest>[0]['owner'], at = host()) {
  const id = startAvatarRequest({ description: 'a fox', agent: 'codex', owner, host: at })
  if (!id) {
    throw new Error('not started')
  }
  return { id, host: at }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((done) => setTimeout(done, 0))
  }
}

describe('avatar generation requests', () => {
  beforeEach(() => {
    mocks.uploadBotAvatar.mockImplementation(async (ref: Bot) => ({
      ...bot(),
      id: ref.id,
      avatar: 'upload:abc',
      avatarRevision: 9
    }))
    mocks.botHostHas.mockReturnValue(true)
    mocks.readHostBots.mockReturnValue([])
  })
  afterEach(() => {
    resetAvatarRequestsForTests()
    vi.clearAllMocks()
  })

  it("uploads a bot's picture behind its revision, sending 0 for a bot that has none", async () => {
    const land = nextRun()
    const { host: at } = startFor({ kind: 'bot', bot: bot() })

    await land(made)
    await flush()

    expect(at.landed).toHaveBeenCalledWith({ png: 'CROPPED', description: 'a fox' }, false)
    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith({ hostId: 'local', id: 'b1' }, 'CROPPED', 0)
    expect(mocks.keepSavedPictureDescription).toHaveBeenCalledWith(
      expect.objectContaining({ avatar: 'upload:abc' }),
      'CROPPED',
      'a fox',
      { prefer: 'known' }
    )
  })

  it('makes no upload once a picture or color was chosen for the bot after Generate', async () => {
    const land = nextRun()
    const { host: at } = startFor({ kind: 'bot', bot: bot({ avatarRevision: 3 }) })

    noteBotPictureChoice(BOT_KEY)
    await land(made)
    await flush()

    expect(at.landed).toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('makes no upload where the host cannot check the revision, open or closed', async () => {
    mocks.botHostHas.mockReturnValue(false)
    const land = nextRun()
    startFor({ kind: 'bot', bot: bot() })
    await land(made)
    await flush()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    nextRun()
    const closed = startFor({ kind: 'bot', bot: bot() })
    releaseAvatarRequest(closed.id)
    expect(mocks.cancel).toHaveBeenCalledWith({ requestId: closed.id })
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't generate a picture for Scout.")
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('waits for a save begun before Generate, and requires the revision it is acknowledged at', async () => {
    const op = beginBotPictureOp(BOT_KEY)
    const land = nextRun()
    startFor({ kind: 'bot', bot: bot({ avatarRevision: 2 }) })

    await land(made)
    await flush()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()

    noteBotPictureAck(BOT_KEY, 3)
    op.end()
    await flush()
    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(expect.anything(), 'CROPPED', 3)
  })

  it('keeps the revision at Generate when a save begun before it failed, past a newer write elsewhere', async () => {
    // Another window set a picture (revision 7) while this window's own save was failing.
    mocks.readHostBots.mockReturnValue([bot({ avatarRevision: 7 })])
    const op = beginBotPictureOp(BOT_KEY)
    const land = nextRun()
    startFor({ kind: 'bot', bot: bot({ avatarRevision: 2 }) })

    noteBotPictureFailure(BOT_KEY)
    op.end()
    await land(made)
    await flush()

    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(expect.anything(), 'CROPPED', 2)
  })

  it('stays silent when a newer write landed first, and saves no caption', async () => {
    mocks.uploadBotAvatar.mockRejectedValueOnce(new Error('bot_avatar_changed'))
    const land = nextRun()
    const { id } = startFor({ kind: 'bot', bot: bot() })
    releaseAvatarRequest(id)

    await land(made)
    await flush()

    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.keepSavedPictureDescription).not.toHaveBeenCalled()
  })

  it('lands on its own once its settings view closes, and says so when it fails there', async () => {
    const land = nextRun()
    const { id, host: at } = startFor({ kind: 'bot', bot: bot() })
    releaseAvatarRequest(id)
    await land(made)
    await flush()
    expect(at.landed).not.toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)

    const fail = nextRun()
    const second = startFor({ kind: 'bot', bot: bot() })
    releaseAvatarRequest(second.id)
    await fail({ ok: false, error: 'timed-out', agent: 'codex' })
    await flush()
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't generate a picture for Scout.")
  })

  it('ends a run for a bot not yet made when its dialog goes', async () => {
    const land = nextRun()
    const { id, host: at } = startFor({ kind: 'draft', key: 'draft-1' })
    releaseAvatarRequest(id)
    await land(made)
    await flush()

    expect(mocks.cancel).toHaveBeenCalledWith({ requestId: id })
    expect(at.landed).not.toHaveBeenCalled()
  })

  it('lets a dialog place its own picture, unless a newer choice was made there', async () => {
    const land = nextRun()
    const first = startFor({ kind: 'draft', key: 'draft-1' })
    await land(made)
    expect(first.host.landed).toHaveBeenCalledWith(expect.anything(), true)

    const again = nextRun()
    const second = startFor({ kind: 'draft', key: 'draft-1' })
    noteBotPictureChoice('draft-1')
    await again(made)
    expect(second.host.landed).toHaveBeenCalledWith(expect.anything(), false)
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('holds a picture made while Create runs, then uploads it once to the bot made', async () => {
    const land = nextRun()
    const { id, host: at } = startFor({ kind: 'draft', key: 'draft-1' })
    const handOff = handOffAvatarRequest(id, { hostId: 'local', name: 'Scout' })

    await land(made)
    await flush()
    expect(at.landed).not.toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()

    handOff?.created(bot({ id: 'b2', avatarRevision: 1 }))
    releaseAvatarRequest(id)
    await flush()
    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith({ hostId: 'local', id: 'b2' }, 'CROPPED', 1)
  })

  it('uploads once to a bot made before its picture lands', async () => {
    const land = nextRun()
    const { id } = startFor({ kind: 'draft', key: 'draft-1' })
    handOffAvatarRequest(id, { hostId: 'local', name: 'Scout' })?.created(bot({ id: 'b2' }))
    releaseAvatarRequest(id)

    await land(made)
    await flush()

    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith({ hostId: 'local', id: 'b2' }, 'CROPPED', 0)
  })

  it('gives the picture back to the dialog when Create fails', async () => {
    const land = nextRun()
    const { id, host: at } = startFor({ kind: 'draft', key: 'draft-1' })
    const handOff = handOffAvatarRequest(id, { hostId: 'local', name: 'Scout' })
    await land(made)
    handOff?.failed()

    expect(at.landed).toHaveBeenCalledWith(expect.anything(), true)
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('cancels on request and ignores the late result', async () => {
    const land = nextRun()
    const { id, host: at } = startFor({ kind: 'bot', bot: bot() })
    cancelAvatarRequest(id)
    await land(made)
    await flush()

    expect(mocks.cancel).toHaveBeenCalledWith({ requestId: id })
    expect(at.landed).not.toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })
})
