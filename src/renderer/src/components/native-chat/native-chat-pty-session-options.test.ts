import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
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

  it('keeps an unknown toggle unknown after the one-shot action', async () => {
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
    const fastBefore = surface.getSnapshot().find(({ id }) => id === 'fastMode')
    expect(fastBefore?.action?.type).toBe('toggle-command')

    const result = await surface.setOption('fastMode', true)
    expect(dispatch).toHaveBeenCalledWith('/fast')
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
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

    const result = await surface.setOption('effort', 'xhigh')
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
