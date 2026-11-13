import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
describe('native chat PTY session options', () => {
  let scopeKey: string
  beforeEach(() => {
    clearNativeChatSessionOptionCacheForTests()
    scopeKey = `native-chat-pty-session-options:${randomUUID()}`
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

  it('keeps model, defaults and picker callbacks unchanged when a foreign Terminal draft blocks any control', async () => {
    const persist = vi.fn()
    const picker = vi.fn()
    seedNativeChatAppliedSessionOptions('blocked-claude', 'claude', {
      model: 'opus',
      effort: 'high'
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'blocked-claude',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: () => ({ outcome: 'blocked', reason: 'foreign-draft', agent: 'claude' }),
      persistSelection: persist,
      onAgentPicker: picker
    })!
    await expect(surface.setOption('model', 'haiku')).rejects.toThrow()
    await expect(surface.invokeAction('fastMode')).rejects.toThrow()
    expect(surface.getSnapshot().find(({ id }) => id === 'model')).toMatchObject({
      kind: { currentValue: 'opus' },
      valueSource: 'applied'
    })
    seedNativeChatAppliedSessionOptions('blocked-codex', 'codex', { model: 'gpt-6.1' })
    const codex = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'blocked-codex',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: () => ({ outcome: 'blocked', reason: 'foreign-draft', agent: 'codex' }),
      persistSelection: persist,
      onAgentPicker: picker
    })!
    await expect(codex.invokeAction('model')).rejects.toThrow()
    expect(codex.getSnapshot().find(({ id }) => id === 'model')).toMatchObject({
      kind: { currentValue: 'gpt-6.1' },
      valueSource: 'applied'
    })
    expect(persist).not.toHaveBeenCalled()
    expect(picker).not.toHaveBeenCalled()
  })

  it('leaves flip-only unknown after a one-shot so the UI never invents on/off', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high'
    })
    const dispatch = vi.fn()
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch,
      persistSelection: persist
    })!
    const fastBefore = surface.getSnapshot().find(({ id }) => id === 'fastMode')
    expect(fastBefore?.action?.type).toBe('toggle-command')
    expect(fastBefore?.kind).toMatchObject({ type: 'boolean' })
    expect(fastBefore?.kind).not.toHaveProperty('defaultValue')

    await expect(surface.setOption('fastMode', true)).rejects.toThrow(
      'Current value is unknown; use the Toggle action instead.'
    )
    expect(dispatch).not.toHaveBeenCalled()
    const result = await surface.invokeAction('fastMode')
    expect(dispatch).toHaveBeenCalledWith('/fast', {
      intent: { kind: 'toggle', optionId: 'fastMode', modelId: 'opus' }
    })
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it('serializes concurrent setOption calls so later writes win in order', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    let releaseFirst: (() => void) | undefined
    const dispatch = vi.fn((command: string) => {
      if (command === '/fast') {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve()
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch
    })!

    const first = surface.setOption('fastMode', false)
    const second = surface.setOption('effort', 'low')
    // Wait for the microtask-queued applier to dispatch before testing serialization.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch).not.toHaveBeenCalledWith('/effort low', expect.anything())
    releaseFirst?.()
    await first
    await second
    expect(dispatch).toHaveBeenCalledWith('/effort low', {
      intent: {
        kind: 'set',
        optionId: 'effort',
        value: 'low',
        modelId: 'opus',
        values: { model: 'opus', effort: 'high', fastMode: false }
      }
    })
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      kind: { currentValue: 'low' }
    })
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      kind: { currentValue: false }
    })
  })

  it('passes an unknown persisted model through as a literal choice', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'future-model'
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch
    })!
    const model = surface.getSnapshot()[0]
    expect(model.kind).toMatchObject({
      currentValue: 'future-model',
      choices: expect.arrayContaining([
        { value: 'future-model', label: 'Future Model', description: 'future-model' }
      ])
    })
    await surface.setOption('model', 'future-model')
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('/model future-model', {
      detectAgentInteraction: 'claude-model-switch-confirmation',
      expectedChoiceLabel: 'Future Model',
      intent: {
        kind: 'set',
        optionId: 'model',
        value: 'future-model',
        modelId: 'future-model',
        values: { model: 'future-model' }
      }
    })
  })
})
