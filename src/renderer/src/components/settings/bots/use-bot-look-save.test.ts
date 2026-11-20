import { describe, expect, it } from 'vitest'
import { saveBotLook, type BotLookUpdate } from './use-bot-look-save'

describe('saveBotLook', () => {
  it('sends picks made behind a slow save as one save of the latest look', async () => {
    const sent: BotLookUpdate[] = []
    let release = (): void => {}
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return sent.length === 1 ? first : Promise.resolve()
    }
    const drained = saveBotLook('local:b1', { avatarColor: '#f4c4cf' }, update)
    void saveBotLook('local:b1', { avatarOutfit: 'tie' }, update)
    void saveBotLook('local:b1', { avatarColor: '#c5dfb5' }, update)
    void saveBotLook('local:b1', { avatarOutfit: 'party' }, update)
    release()
    await drained
    expect(sent).toEqual([
      { avatarColor: '#f4c4cf' },
      { avatarColor: '#c5dfb5', avatarOutfit: 'party' }
    ])
  })
})
