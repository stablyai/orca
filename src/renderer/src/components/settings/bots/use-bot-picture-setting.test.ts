// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { mascotAvatar, PICKABLE_BOT_MASCOT_IDS } from '../../../../../shared/bot-avatar'

const mocks = vi.hoisted(() => {
  const catalog: Bot[] = []
  return { catalog, uploadBotAvatar: vi.fn(), readBotAvatarPng: vi.fn(async () => null) }
})

vi.mock('@/lib/bot-catalog', () => ({
  readHostBots: () => mocks.catalog,
  uploadBotAvatar: mocks.uploadBotAvatar,
  readBotAvatarPng: mocks.readBotAvatarPng
}))
vi.mock('@/components/bots/bot-avatar-image', () => ({
  useBotAvatarLook: () => ({ src: null, outfit: null })
}))
vi.mock('@/lib/bot-host-refresh', () => ({ beginBotHostUpdate: () => () => {} }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { BOT_PICTURE_SAVE_DELAY_MS, useBotPictureSetting } from './use-bot-picture-setting'
import {
  beginAutomaticBotPictureUpload,
  subscribeBotPictureEvents,
  type BotPictureEvent
} from '@/components/bots/bot-picture-ops'

const A = PICKABLE_BOT_MASCOT_IDS[0]
const B = PICKABLE_BOT_MASCOT_IDS[1]
const KEY = 'local\u0000b1'

function bot(overrides: Partial<Bot> = {}): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
  return {
    id: 'b1',
    hostId: 'local',
    name: 'Scout',
    avatar: mascotAvatar(A),
    avatarColor: null,
    ...overrides
  } as Bot
}

describe('useBotPictureSetting', () => {
  let events: BotPictureEvent[]
  let stop: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    stop = subscribeBotPictureEvents((event) => events.push(event))
    mocks.catalog = [bot()]
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('notes a pick as a choice and holds a ledger op until its save is acknowledged', async () => {
    let finish: (saved: Bot) => void = () => {}
    const update = vi.fn(() => new Promise<Bot | null>((done) => (finish = done)))
    const { result } = renderHook(() => useBotPictureSetting(bot(), update))

    act(() => result.current.pick({ kind: 'mascot', index: 1 }))
    expect(events).toEqual([{ kind: 'choice', key: KEY }])
    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })
    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar(B) })
    await act(async () => finish(bot({ avatar: mascotAvatar(B), avatarRevision: 4 })))

    expect(events).toEqual([
      { kind: 'choice', key: KEY },
      { kind: 'ack', key: KEY, revision: 4 },
      { kind: 'idle', key: KEY }
    ])
  })

  it('notes an outfit-only pick as a choice and holds a ledger op until its save is acknowledged', async () => {
    let finish: (saved: Bot) => void = () => {}
    const update = vi.fn(() => new Promise<Bot | null>((done) => (finish = done)))
    const { result } = renderHook(() => useBotPictureSetting(bot(), update))

    act(() => result.current.pickOutfit('tie'))
    expect(events).toEqual([{ kind: 'choice', key: KEY }])
    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })
    expect(update).toHaveBeenCalledWith({ avatarOutfit: 'tie' })
    // Still open: a picture asked for now waits for this save's revision.
    expect(events).toEqual([{ kind: 'choice', key: KEY }])
    await act(async () => finish(bot({ avatarOutfit: 'tie', avatarRevision: 5 })))

    expect(events).toEqual([
      { kind: 'choice', key: KEY },
      { kind: 'ack', key: KEY, revision: 5 },
      { kind: 'idle', key: KEY }
    ])
  })

  it('sends the saved picture again when it is picked while a generated one is uploading', async () => {
    const update = vi.fn(async () => bot({ avatarRevision: 2 }))
    const { result } = renderHook(() => useBotPictureSetting(bot(), update))
    const automatic = beginAutomaticBotPictureUpload(KEY)

    act(() => result.current.pick({ kind: 'mascot', index: 0 }))
    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })
    automatic.end()

    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar(A) })
  })

  it('still sends a pick waiting on its delay when the generated upload settles first', async () => {
    const update = vi.fn(async () => bot({ avatarRevision: 2 }))
    const { result } = renderHook(() => useBotPictureSetting(bot(), update))
    act(() => result.current.pick({ kind: 'mascot', index: 1 }))
    act(() => result.current.pick({ kind: 'mascot', index: 0 }))
    const automatic = beginAutomaticBotPictureUpload(KEY)
    act(() => automatic.end())

    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })

    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar(A) })
  })

  it('shows the picture set elsewhere when its own save fails', async () => {
    let refuse: () => void = () => {}
    const update = vi.fn(() => new Promise<Bot | null>((done) => (refuse = () => done(null))))
    const { result } = renderHook(() => useBotPictureSetting(bot(), update))
    act(() => result.current.pick({ kind: 'mascot', index: 1 }))
    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })
    // Another window set mascot 3 while this save was in flight; the prop hasn't caught up.
    const C = PICKABLE_BOT_MASCOT_IDS[2]
    mocks.catalog = [bot({ avatar: mascotAvatar(C) })]

    await act(async () => refuse())

    expect(result.current.value).toEqual({ kind: 'mascot', index: 2 })
    expect(events.at(-2)).toEqual({ kind: 'failed', key: KEY })
  })

  it('opens a ledger op as a picture starts being taken in, a choice from then', () => {
    const { result } = renderHook(() => useBotPictureSetting(bot(), vi.fn()))
    let end: () => void = () => {}
    act(() => {
      end = result.current.beginIntake()
    })
    expect(events).toEqual([{ kind: 'choice', key: KEY }])
    end()
    expect(events).toEqual([
      { kind: 'choice', key: KEY },
      { kind: 'idle', key: KEY }
    ])
  })
})
