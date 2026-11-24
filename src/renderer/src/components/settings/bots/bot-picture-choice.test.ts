import { expect, it } from 'vitest'
import {
  BOT_SHAPE_AVATAR,
  isSettableBotAvatar,
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS
} from '../../../../../shared/bot-avatar'
import { choiceKey, savedChoice } from './bot-picture-choice'

it('reads the shape as its own kind and any other unknown mascot as nothing', () => {
  expect(parseBotAvatar(BOT_SHAPE_AVATAR)).toEqual({ kind: 'shape' })
  expect(isSettableBotAvatar(BOT_SHAPE_AVATAR)).toBe(true)
  expect(parseBotAvatar('mascot:shape-unknown')).toBeNull()
})

it('saves and reopens the shape and every offered mascot as the same choice', () => {
  expect(savedChoice(choiceKey({ kind: 'shape' }, null))).toEqual({ kind: 'shape' })
  PICKABLE_BOT_MASCOT_IDS.forEach((id, index) => {
    expect(choiceKey(savedChoice(mascotAvatar(id)), null)).toBe(mascotAvatar(id))
    expect(savedChoice(mascotAvatar(id))).toEqual({ kind: 'mascot', index })
  })
  // An upload or an emoji stays the bot's own picture, never the shape.
  expect(savedChoice('upload:abc')).toEqual({ kind: 'custom' })
  expect(savedChoice('🦊')).toEqual({ kind: 'custom' })
})
