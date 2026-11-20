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
    const drained = new Promise<void>((resolve) => {
      saveBotLook('local:b1', { avatarColor: '#f4c4cf' }, update, resolve)
    })
    saveBotLook('local:b1', { avatarOutfit: 'tie' }, update)
    saveBotLook('local:b1', { avatarColor: '#c5dfb5' }, update)
    saveBotLook('local:b1', { avatarOutfit: 'party' }, update)
    release()
    await drained
    expect(sent).toEqual([
      { avatarColor: '#f4c4cf' },
      { avatarColor: '#c5dfb5', avatarOutfit: 'party' }
    ])
  })

  it('holds the host re-read back while a pick waits, so the save ahead of it returns on landing', async () => {
    const events: string[] = []
    let release = (): void => {}
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const update = (look: BotLookUpdate): Promise<unknown> => {
      events.push(`send ${look.avatarColor ?? look.avatarOutfit}`)
      return events.length === 1 ? first : Promise.resolve()
    }
    const hold = (): (() => void) => {
      events.push('hold')
      return () => events.push('release')
    }
    const drained = new Promise<void>((resolve) => {
      saveBotLook('local:b2', { avatarColor: '#f4c4cf' }, update, resolve, hold)
    })
    saveBotLook('local:b2', { avatarOutfit: 'tie' }, update, undefined, hold)
    saveBotLook('local:b2', { avatarOutfit: 'party' }, update, undefined, hold)
    release()
    await drained
    expect(events).toEqual(['send #f4c4cf', 'hold', 'send party', 'release'])
  })
})
