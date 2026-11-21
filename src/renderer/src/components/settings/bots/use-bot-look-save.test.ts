// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { saveBotLook, useBotLookSave, type BotLookUpdate } from './use-bot-look-save'

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

  it('holds the host re-read back until the last pick lands, so each save returns on landing', async () => {
    const events: string[] = []
    let release = (): void => {}
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    let sends = 0
    const update = (look: BotLookUpdate): Promise<unknown> => {
      events.push(`send ${look.avatarColor ?? look.avatarOutfit}`)
      sends += 1
      return sends === 1 ? first : Promise.resolve()
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
    expect(events).toEqual(['hold', 'send #f4c4cf', 'send party', 'release'])
  })

  it('sends a pick still waiting behind a slow save when the window goes, so quitting keeps it', () => {
    const sent: BotLookUpdate[] = []
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return new Promise(() => {})
    }
    saveBotLook('local:b3', { avatarColor: '#f4c4cf' }, update)
    saveBotLook('local:b3', { avatarOutfit: 'tie' }, update)
    window.dispatchEvent(new Event('pagehide'))
    expect(sent).toEqual([{ avatarColor: '#f4c4cf' }, { avatarOutfit: 'tie' }])
  })

  it('sends a pick still in its pause when the window goes', () => {
    const sent: BotLookUpdate[] = []
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return Promise.resolve()
    }
    const { result } = renderHook(() => useBotLookSave('local:b4', update, 500))
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    window.dispatchEvent(new Event('pagehide'))
    expect(sent).toEqual([{ avatarOutfit: 'tie' }])
  })
})

describe('looks that change nothing', () => {
  function recorder(slowFirst = false): {
    sent: BotLookUpdate[]
    update: (look: BotLookUpdate) => Promise<unknown>
  } {
    const sent: BotLookUpdate[] = []
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return slowFirst && sent.length === 1 ? new Promise(() => {}) : Promise.resolve()
    }
    return { sent, update }
  }

  it('sends nothing for the saved outfit, or for another outfit and back within the pause', () => {
    const { sent, update } = recorder()
    const { result } = renderHook(() =>
      useBotLookSave('local:b5', update, 500, undefined, { avatarOutfit: 'tie' })
    )
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    act(() => result.current.flush())
    act(() => result.current.pick({ avatarOutfit: 'party' }))
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    act(() => result.current.flush())
    expect(sent).toEqual([])
  })

  it('sends nothing for the default color picked over the same color stored', () => {
    const { sent, update } = recorder()
    saveBotLook('local:b6', { avatarColor: null }, update, undefined, undefined, {
      avatarColor: '#b3dbf4'
    })
    expect(sent).toEqual([])
  })

  it('lets a later pick of the saved outfit cancel one still waiting behind a slow save', () => {
    const { sent, update } = recorder(true)
    const saved = { avatarColor: null, avatarOutfit: 'tie' }
    saveBotLook('local:b7', { avatarColor: '#f4c4cf' }, update, undefined, undefined, saved)
    saveBotLook('local:b7', { avatarOutfit: 'party' }, update)
    saveBotLook('local:b7', { avatarOutfit: 'tie' }, update)
    window.dispatchEvent(new Event('pagehide'))
    expect(sent).toEqual([{ avatarColor: '#f4c4cf' }])
  })

  it('sends a pick again when the save it repeated, or its own, fails', async () => {
    const sent: BotLookUpdate[] = []
    let fail = (): void => {}
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return sent.length === 1
        ? new Promise((resolve) => (fail = () => resolve(null)))
        : Promise.resolve(null)
    }
    const saved = { avatarOutfit: 'tie' }
    const drained = new Promise<void>((resolve) => {
      saveBotLook('local:b8', { avatarOutfit: 'party' }, update, resolve, undefined, saved)
    })
    saveBotLook('local:b8', { avatarOutfit: 'party' }, update)
    fail()
    await drained
    // The bot still shows party, but the host never took it.
    saveBotLook('local:b8', { avatarOutfit: 'party' }, update, undefined, undefined, {
      avatarOutfit: 'party'
    })
    expect(sent).toEqual([
      { avatarOutfit: 'party' },
      { avatarOutfit: 'party' },
      { avatarOutfit: 'party' }
    ])
  })

  it('shows nothing new for a pick of the selected outfit, and never delays an earlier pick', () => {
    vi.useFakeTimers()
    const { sent, update } = recorder()
    const { result } = renderHook(() =>
      useBotLookSave('local:b9', update, 500, undefined, {
        avatarColor: '#f4c4cf',
        avatarOutfit: 'tie'
      })
    )
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    expect(result.current.picked).toBeNull()

    act(() => result.current.pick({ avatarOutfit: 'party' }))
    act(() => vi.advanceTimersByTime(200))
    act(() => result.current.pick({ avatarColor: '#f4c4cf' }))
    act(() => vi.advanceTimersByTime(300))
    expect(sent).toEqual([{ avatarOutfit: 'party' }])
    vi.useRealTimers()
  })
})
