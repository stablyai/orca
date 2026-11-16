import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedNativeChatAppliedSessionOptions } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { holdNativeChatOptionPicksDuringTurns } from './native-chat-turn-held-option-surface'

describe('native chat turn-held option picks', () => {
  let scopeKey: string
  beforeEach(() => {
    scopeKey = `native-chat-turn-held-option-surface-test:${randomUUID()}`
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', { model: 'opus' })
  })

  const create = () => {
    const dispatch = vi.fn().mockResolvedValue({})
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
})
