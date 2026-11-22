// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchWindowCloseRequest } from '../../../app-shell/shutdown/window-close-request-coordinator'
import { ORCA_APP_RESTART_STARTED_EVENT } from '../../../../../shared/updater/updater-renderer-events'
import { saveBotLook, useBotLookSave, type BotLookUpdate } from './use-bot-look-save'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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

  it('lets a close go on as soon as every look save lands', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    vi.stubGlobal('api', {
      app: { awaitBeforeUnloadCheckpoint: async () => void events.push('checkpoint') },
      ui: {
        confirmWindowClose: () => events.push('close'),
        cancelWindowClose: () => events.push('cancel')
      }
    })
    let land = (): void => {}
    saveBotLook(
      'local:b9',
      { avatarOutfit: 'tie' },
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        })
    )
    const closing = dispatchWindowCloseRequest({ isQuitting: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([])
    land()
    await closing
    expect(events).toEqual(['checkpoint', 'close'])
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

  it('sends a pick still waiting behind a slow save when a restart starts, before its checkpoint', () => {
    const sent: BotLookUpdate[] = []
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return new Promise(() => {})
    }
    saveBotLook('local:b10', { avatarColor: '#f4c4cf' }, update)
    saveBotLook('local:b10', { avatarOutfit: 'tie' }, update)
    window.dispatchEvent(new Event(ORCA_APP_RESTART_STARTED_EVENT))
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

  it('quitting waits for a pick on its way before the last checkpoint, and a save that never lands cannot hold quit', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    vi.stubGlobal('api', {
      app: { awaitBeforeUnloadCheckpoint: async () => void events.push('checkpoint') },
      ui: {
        confirmWindowClose: () => events.push('close'),
        cancelWindowClose: () => events.push('cancel')
      }
    })
    saveBotLook('local:b7', { avatarColor: '#f4c4cf' }, () => new Promise(() => {}))
    let land = (): void => {}
    const update = (look: BotLookUpdate): Promise<unknown> => {
      events.push(`send ${look.avatarOutfit}`)
      return new Promise<void>((resolve) => {
        land = () => resolve(void events.push('landed'))
      })
    }
    const { result } = renderHook(() => useBotLookSave('local:b8', update, 500))
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    const closing = dispatchWindowCloseRequest({ isQuitting: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['send tie'])
    land()
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['send tie', 'landed'])
    await vi.advanceTimersByTimeAsync(2000)
    await closing
    expect(events).toEqual(['send tie', 'landed', 'checkpoint', 'close'])
  })
})

describe('useBotLookSave picks of the saved look', () => {
  it('sends nothing and shows nothing new for the saved outfit or the default color stored', () => {
    const sent: BotLookUpdate[] = []
    const update = (look: BotLookUpdate): Promise<unknown> => {
      sent.push(look)
      return Promise.resolve()
    }
    const { result } = renderHook(() =>
      useBotLookSave('local:b5', update, 500, undefined, {
        avatarColor: '#b3dbf4',
        avatarOutfit: 'tie'
      })
    )
    act(() => result.current.pick({ avatarOutfit: 'tie' }))
    act(() => result.current.pick({ avatarColor: null }))
    act(() => result.current.flush())
    expect(result.current.picked).toBeNull()
    expect(sent).toEqual([])
  })
})
