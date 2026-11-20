import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedNativeChatAppliedSessionOptions } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import {
  dropNativeChatTurnHeldOptionPicks,
  holdNativeChatOptionPicksDuringTurns
} from './native-chat-turn-held-option-surface'

describe('native chat turn-held option picks', () => {
  let scopeKey: string
  beforeEach(() => {
    scopeKey = `native-chat-turn-held-option-surface-test:${randomUUID()}`
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', { model: 'opus' })
  })

  const create = (dispatch = vi.fn().mockResolvedValue({})) => {
    const surface = holdNativeChatOptionPicksDuringTurns({
      surface: createNativeChatPtySessionOptions({
        agent: 'claude',
        scopeKey,
        mode: 'live',
        modelLabel: 'Model',
        dispatchCommand: dispatch
      })!,
      scopeKey
    })
    const model = () => surface.getSnapshot().find(({ id }) => id === 'model')
    return { dispatch, surface, model }
  }

  it('holds a mid-turn model pick and sends it once when the turn ends', async () => {
    const { dispatch, surface, model } = create()
    surface.setWorking(true)
    await surface.setOption('model', 'haiku')
    await surface.setOption('model', 'sonnet')
    expect(dispatch).not.toHaveBeenCalled()
    expect(model()).toMatchObject({ kind: { currentValue: 'sonnet' }, appliesAfterTurn: true })

    surface.setWorking(false)
    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toBe('/model sonnet')
    await vi.waitFor(() => expect(model()?.appliesAfterTurn).toBeUndefined())
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('clears the held pick when the running model is picked again', async () => {
    const { dispatch, surface, model } = create()
    surface.setWorking(true)
    await surface.setOption('model', 'sonnet')
    await surface.setOption('model', 'opus')
    expect(model()).toMatchObject({ kind: { currentValue: 'opus' } })
    expect(model()?.appliesAfterTurn).toBeUndefined()

    surface.setWorking(false)
    await Promise.resolve()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('compares a repeated pick with the model the agent reports now', async () => {
    const { dispatch, surface, model } = create()
    surface.setWorking(true)
    await surface.setOption('model', 'sonnet')
    surface.reportSessionOptions({ model: 'haiku' })
    await surface.setOption('model', 'opus')
    expect(model()).toMatchObject({ kind: { currentValue: 'opus' }, appliesAfterTurn: true })

    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toBe('/model opus')
  })

  it('stops sending and showing picks of a chat that was left', async () => {
    let finishFirst: (() => void) | undefined
    const dispatch = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finishFirst ??= () => resolve({})
        })
    )
    const { surface } = create(dispatch)
    surface.setWorking(true)
    await surface.setOption('model', 'sonnet')
    await surface.setOption('effort', 'low')
    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    dropNativeChatTurnHeldOptionPicks(scopeKey)
    finishFirst?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)

    const other = create()
    other.surface.setWorking(true)
    await other.surface.setOption('model', 'haiku')
    dropNativeChatTurnHeldOptionPicks(scopeKey)
    other.surface.setWorking(true)
    expect(other.model()?.appliesAfterTurn).toBeUndefined()
  })

  it('keeps a rebuilt surface waiting while a held pick is typed', async () => {
    let finish: (() => void) | undefined
    const dispatch = vi.fn(() => new Promise<object>((resolve) => (finish = () => resolve({}))))
    const { surface } = create(dispatch)
    surface.setWorking(true)
    await surface.setOption('model', 'sonnet')
    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))

    const rebuilt = create(dispatch)
    expect(rebuilt.surface.sendingHeldPick()).toBe('model')
    finish?.()
    await vi.waitFor(() => expect(rebuilt.surface.sendingHeldPick()).toBeNull())
  })

  it('holds the rest of the picks again when a turn starts while they are typed', async () => {
    let finish: (() => void) | undefined
    const dispatch = vi.fn(
      (_command: string) => new Promise<object>((resolve) => (finish = () => resolve({})))
    )
    const { surface } = create(dispatch)
    surface.setWorking(true)
    await surface.setOption('model', 'sonnet')
    await surface.setOption('effort', 'low')
    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toBe('/model sonnet')

    surface.setWorking(true)
    finish?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')?.appliesAfterTurn).toBe(true)

    surface.setWorking(false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatch.mock.calls[1]?.[0]).toContain('low')
  })
})
