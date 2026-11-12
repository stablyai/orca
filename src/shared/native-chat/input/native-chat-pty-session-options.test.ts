import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedNativeChatAppliedSessionOptions } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'

describe('native chat PTY session options', () => {
  let scopeKey: string
  beforeEach(() => {
    scopeKey = `native-chat-pty-session-options-test:${randomUUID()}`
  })

  it('does not re-assert absolute state when a typed flip clears tracking mid-dispatch', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    let resolveDispatch: (() => void) | undefined
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve
        })
    )
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch
    })!

    const pending = surface.setOption('fastMode', false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    // A typed flip during dispatch must supersede the picker’s value.
    surface.recordOutgoingCommand('/fast')
    resolveDispatch?.()
    await pending
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
  })

  it('never lets a tracked-only model mark discovered rows legacy', () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'codex', { model: 'gpt-7-sol' })
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      initialModels: [
        { id: 'gpt-6-sol', label: 'Sol', options: [] },
        { id: 'gpt-5.6-luna', label: 'Luna', options: [] }
      ],
      dispatchCommand: async () => {}
    })!
    const model = surface.getSnapshot().find(({ id }) => id === 'model')
    const choices = model?.kind.type === 'select' ? model.kind.choices : []
    expect(choices.map(({ value }) => value)).toEqual(['gpt-6-sol', 'gpt-5.6-luna', 'gpt-7-sol'])
    expect(choices.filter(({ legacy }) => legacy).map(({ value }) => value)).toEqual([
      'gpt-5.6-luna'
    ])
  })
})
