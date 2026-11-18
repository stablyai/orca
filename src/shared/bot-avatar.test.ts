import { describe, expect, it } from 'vitest'
import {
  BOT_MASCOT_IDS,
  isSettableBotAvatar,
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS,
  randomMascotAvatar,
  uploadAvatar
} from './bot-avatar'

describe('bot avatars', () => {
  it('reads a mascot, an upload and an emoji saved before mascots', () => {
    expect(parseBotAvatar(mascotAvatar('K2'))).toEqual({ kind: 'mascot', id: 'K2' })
    expect(parseBotAvatar(uploadAvatar('abc'))).toEqual({ kind: 'upload', version: 'abc' })
    expect(parseBotAvatar('🦊')).toEqual({ kind: 'emoji', emoji: '🦊' })
    expect(parseBotAvatar(null)).toBeNull()
    // A mascot a newer Orca added shows the initial rather than a broken picture.
    expect(parseBotAvatar('mascot:Z9')).toBeNull()
  })

  it('never shuffles to the mascot already shown', () => {
    for (const id of BOT_MASCOT_IDS) {
      for (const draw of [0, 0.5, 0.999999]) {
        expect(randomMascotAvatar(mascotAvatar(id), () => draw)).not.toBe(mascotAvatar(id))
      }
    }
    expect(BOT_MASCOT_IDS.map((id) => mascotAvatar(id))).toContain(randomMascotAvatar(null))
  })

  it('never offers the retired penguin (S2), though a bot that has it still shows it', () => {
    expect(PICKABLE_BOT_MASCOT_IDS).not.toContain('S2')
    // Every slot of the full list, the retired one's included.
    for (let slot = 0; slot < BOT_MASCOT_IDS.length; slot++) {
      const draw = (slot + 0.5) / BOT_MASCOT_IDS.length
      expect(randomMascotAvatar(null, () => draw)).not.toBe(mascotAvatar('S2'))
    }
    expect(parseBotAvatar(mascotAvatar('S2'))).toEqual({ kind: 'mascot', id: 'S2' })
    expect(isSettableBotAvatar(mascotAvatar('S2'))).toBe(true)
  })

  it('lets a client set a mascot, an emoji or nothing, but never claim an upload', () => {
    expect(isSettableBotAvatar(mascotAvatar('A1'))).toBe(true)
    expect(isSettableBotAvatar('🦊')).toBe(true)
    expect(isSettableBotAvatar(null)).toBe(true)
    expect(isSettableBotAvatar(uploadAvatar('abc'))).toBe(false)
    expect(isSettableBotAvatar('mascot:Z9')).toBe(false)
  })
})
