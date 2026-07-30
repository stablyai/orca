import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'

describe('native chat PTY session options', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('starts attached sessions unknown and hides model-scoped options', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    expect(surface.getSnapshot()).toHaveLength(1)
    expect(surface.getSnapshot()[0]).toMatchObject({
      id: 'model',
      valueSource: 'unknown'
    })
  })

  it('uses model and effort reported by the live Claude terminal', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      reportedValues: { model: 'opus', effort: 'medium' },
      dispatchCommand: vi.fn()
    })!

    expect(surface.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model',
          valueSource: 'reported',
          kind: expect.objectContaining({ currentValue: 'opus' })
        }),
        expect.objectContaining({
          id: 'effort',
          valueSource: 'reported',
          kind: expect.objectContaining({ currentValue: 'medium' })
        })
      ])
    )
  })

  it('restores launch-backed values through the tab-to-PTY cache handoff', () => {
    seedNativeChatAppliedSessionOptions('tab-1', 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      fallbackScopeKey: 'tab-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    expect(surface.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'model', valueSource: 'applied' }),
        expect.objectContaining({ id: 'effort', valueSource: 'applied' }),
        expect.objectContaining({ id: 'fastMode', valueSource: 'unknown' })
      ])
    )
  })

  it('dispatches a Claude effort setter and publishes the full snapshot', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const dispatch = vi.fn()
    const persist = vi.fn()
    const listener = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      persistSelection: persist
    })!
    surface.subscribe(listener)

    const effortResult = await surface.setOption('effort', 'high')
    expect(dispatch).toHaveBeenCalledWith('/effort high')
    expect(effortResult.snapshot.map(({ id }) => id)).toEqual(['model', 'effort', 'fastMode'])
    expect(effortResult.snapshot.find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls.every(([snapshot]) => Array.isArray(snapshot))).toBe(true)
    expect(persist).toHaveBeenCalledWith({
      modelId: 'opus',
      optionId: 'effort',
      value: 'high'
    })
  })

  it('keeps a normal Claude model choice native and dispatches the selected model', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'sonnet',
      effort: 'high'
    })
    const dispatch = vi.fn().mockResolvedValue({ outcome: 'applied' })
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      onAgentPicker
    })!
    expect(surface.getSnapshot()[0]?.action).toBeUndefined()

    const result = await surface.setOption('model', 'fable')

    expect(dispatch).toHaveBeenCalledWith('/model fable', {
      detectAgentInteraction: 'claude-model-switch-confirmation',
      expectedChoiceLabel: 'Fable 5'
    })
    expect(onAgentPicker).not.toHaveBeenCalled()
    expect(result.snapshot[0]).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'fable' }
    })
  })

  it('reveals the terminal only when Claude actually requires model-switch interaction', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'sonnet' })
    const dispatch = vi.fn().mockResolvedValue({ outcome: 'interaction-required' })
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      onAgentPicker
    })!

    const result = await surface.setOption('model', 'haiku')

    expect(dispatch).toHaveBeenCalledWith('/model haiku', {
      detectAgentInteraction: 'claude-model-switch-confirmation',
      expectedChoiceLabel: 'Haiku'
    })
    expect(onAgentPicker).toHaveBeenCalledOnce()
    expect(result.snapshot[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('keeps the prior model and persistence when Claude rejects the switch', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'fable',
      effort: 'high'
    })
    const persist = vi.fn()
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn().mockResolvedValue({ outcome: 'rejected' }),
      persistSelection: persist,
      onAgentPicker
    })!

    await expect(surface.setOption('model', 'haiku')).rejects.toThrow(
      'Claude kept the current model.'
    )

    expect(surface.getSnapshot()[0]).toMatchObject({
      valueSource: 'applied',
      kind: { currentValue: 'fable' }
    })
    expect(persist).not.toHaveBeenCalled()
    expect(onAgentPicker).not.toHaveBeenCalled()
  })

  it('stays native and clears stale truth when the switch cannot be verified', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'fable',
      effort: 'high'
    })
    const persist = vi.fn()
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn().mockResolvedValue({ outcome: 'unknown' }),
      persistSelection: persist,
      onAgentPicker
    })!

    await expect(surface.setOption('model', 'haiku')).rejects.toThrow(
      'Could not verify the model change; open the terminal to check.'
    )

    expect(surface.getSnapshot()).toHaveLength(1)
    expect(surface.getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
    expect(persist).not.toHaveBeenCalled()
    expect(onAgentPicker).not.toHaveBeenCalled()
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
    expect(dispatch).toHaveBeenCalledWith('/fast')
    // Why: a flip-only command never reports an absolute value.
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it('no-ops a seeded toggle when already at the requested value', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    const result = await surface.setOption('fastMode', true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'applied',
      kind: { type: 'boolean', currentValue: true }
    })
  })

  it('no-ops a known toggle at the same absolute target (flip is not set-to-value)', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    await surface.setOption('fastMode', false)
    dispatch.mockClear()
    // Why: a second same-target set would re-send `/fast` and invert the agent
    // if the first flip landed — unlike set-to-value commands, flips cannot retry.
    const result = await surface.setOption('fastMode', false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'applied',
      kind: { type: 'boolean', currentValue: false }
    })
  })

  it('dispatches the opposite absolute target for a known toggle', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    await surface.setOption('fastMode', false)
    dispatch.mockClear()
    const result = await surface.setOption('fastMode', true)
    expect(dispatch).toHaveBeenCalledWith('/fast')
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'applied',
      kind: { type: 'boolean', currentValue: true }
    })
  })

  it('tracks a known toggle flip as applied without persisting', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    const dispatch = vi.fn()
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      persistSelection: persist
    })!

    const result = await surface.setOption('fastMode', false)
    expect(dispatch).toHaveBeenCalledWith('/fast')
    // Why: flip-only never heals; applied is best-known absolute, not dispatched.
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'applied',
      kind: { type: 'boolean', currentValue: false }
    })
    expect(result.snapshot.find(({ id }) => id === 'fastMode')?.action).toBeUndefined()
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
      dispatchCommand: dispatch
    })!

    const first = surface.setOption('fastMode', false)
    const second = surface.setOption('effort', 'low')
    // Why: appliers queue on microtasks — wait for the first dispatch to start.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    // Second stays queued until first finishes.
    expect(dispatch).not.toHaveBeenCalledWith('/effort low')
    releaseFirst?.()
    await first
    await second
    expect(dispatch).toHaveBeenCalledWith('/effort low')
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      kind: { currentValue: 'low' }
    })
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      kind: { currentValue: false }
    })
  })

  it('stays unknown after a typed flip then a picker toggle (no invented absolute)', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high'
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    // Typed `/fast` clears any prior tracking; option stays unknown.
    surface.recordOutgoingCommand('/fast')
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })

    await surface.invokeAction('fastMode')
    expect(dispatch).toHaveBeenCalledWith('/fast')
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
  })

  it('does not re-assert absolute state when a typed flip clears tracking mid-dispatch', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
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
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    const pending = surface.setOption('fastMode', false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    // Why: typed `/fast` during await must win — do not write the picker value after.
    surface.recordOutgoingCommand('/fast')
    resolveDispatch?.()
    await pending
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
  })

  it('does not write flip state onto a model that changed mid-dispatch', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
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
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!

    const pending = surface.setOption('fastMode', false)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    surface.recordOutgoingCommand('/model sonnet')
    resolveDispatch?.()
    await pending
    expect(surface.getSnapshot().find(({ id }) => id === 'model')).toMatchObject({
      kind: { currentValue: 'sonnet' }
    })
    // Why: only opus carries fastMode in the catalog. The aborted flip must not
    // pollute the destination model bucket, and must not rewrite the source.
    const cached = readNativeChatSessionOptionCache('pty-1')
    expect(cached?.valuesByModel.sonnet?.fastMode).toBeUndefined()
    expect(cached?.valuesByModel.opus?.fastMode).toMatchObject({
      value: true,
      source: 'applied'
    })
  })

  it('does not commit a non-flip option onto a model that changed mid-dispatch', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'high'
    })
    let resolveDispatch: (() => void) | undefined
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve
        })
    )
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      persistSelection: persist
    })!

    const pending = surface.setOption('effort', 'xhigh')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    // Why: a model switch during await must win — do not write effort after.
    surface.recordOutgoingCommand('/model sonnet')
    resolveDispatch?.()
    await pending

    // Why: the aborted effort commit must not land under the destination model
    // nor persist there, and must leave the source model untouched.
    const cached = readNativeChatSessionOptionCache('pty-1')
    expect(cached?.valuesByModel.sonnet?.effort).toBeUndefined()
    expect(cached?.valuesByModel.opus?.effort).toMatchObject({
      value: 'high',
      source: 'applied'
    })
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ optionId: 'effort', modelId: 'sonnet' })
    )
  })

  it('hands Codex model changes to the TUI picker and drops stale truth', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', {
      model: 'gpt-5.5',
      effort: 'high'
    })
    const dispatch = vi.fn()
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch,
      onAgentPicker
    })!
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')?.action?.type).toBe(
      'agent-picker'
    )

    const result = await surface.invokeAction('effort')
    expect(dispatch).toHaveBeenCalledWith('/model')
    expect(onAgentPicker).toHaveBeenCalledOnce()
    expect(result.snapshot).toHaveLength(1)
    expect(result.snapshot[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('tracks typed effort commands and downgrades typed toggles', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    surface.recordOutgoingCommand('/effort high')
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
    surface.recordOutgoingCommand('/fast')
    expect(surface.getSnapshot().find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown'
    })
  })

  it('switches to the terminal and drops stale truth for a typed picker command', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      onAgentPicker
    })!

    surface.recordOutgoingCommand('/model')

    expect(onAgentPicker).toHaveBeenCalledOnce()
    expect(surface.getSnapshot()).toHaveLength(1)
    expect(surface.getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('passes an unknown persisted model through as a literal choice', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'future-model'
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    const model = surface.getSnapshot()[0]
    expect(model.kind).toMatchObject({
      currentValue: 'future-model',
      choices: expect.arrayContaining([{ value: 'future-model', label: 'future-model' }])
    })
  })

  it('recomposes Cursor model slugs for live option changes', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'cursor', {
      model: 'gpt-5.3-codex',
      effort: 'medium',
      fastMode: true
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'cursor',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')?.settable).toBe(true)

    await surface.setOption('effort', 'high')

    expect(dispatch).toHaveBeenCalledWith('/model gpt-5.3-codex-high-fast')
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
  })
})
