import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { mergeDiscoveredAuthoritativeModels } from '../../../../shared/agent-session-option-catalog'
import { GROK_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-grok'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from '../../../../shared/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat-session-options'

describe('native chat PTY session options', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('renders nothing when no model list exists at all', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      initialModels: [],
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    expect(surface.getSnapshot()).toEqual([])
  })

  it('renders the version-neutral seed picker before any host catalog arrives', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!

    expect(surface.getSnapshot()[0]).toMatchObject({
      id: 'model',
      valueSource: 'unknown',
      kind: {
        choices: [
          expect.objectContaining({ value: 'fable', label: 'Fable' }),
          expect.objectContaining({ value: 'opus', label: 'Opus' }),
          expect.objectContaining({ value: 'sonnet', label: 'Sonnet' }),
          expect.objectContaining({ value: 'haiku', label: 'Haiku' })
        ]
      }
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
      value: 'high',
      // Claude tracks a real model here, so this stays a persistable selection.
      adoptModelAsLaunchDefault: true
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
      expectedChoiceLabel: 'Fable'
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

  it('hands Codex effort changes to the TUI picker and drops stale truth', async () => {
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
    expect(dispatch).toHaveBeenCalledWith('/model', { delivery: 'type' })
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

  it('keeps a tracked alias selectable when the host catalog omits it', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      // Why: current CLIs list `opus[1m]` and no plain `opus`.
      initialModels: [
        { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
        { id: 'sonnet', label: 'Sonnet', options: [] }
      ],
      mode: 'live',
      dispatchCommand: dispatch
    })!

    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'opus',
      choices: expect.arrayContaining([
        { value: 'opus', label: 'Opus', description: expect.any(String) }
      ])
    })
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      settable: true,
      kind: { currentValue: 'xhigh' }
    })

    await surface.setOption('effort', 'high')

    expect(dispatch).toHaveBeenCalledWith('/effort high')
  })

  it('drops the reconciled row once the tracked model moves onto the host catalog', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'opus' })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      initialModels: [{ id: 'opus[1m]', label: 'Opus (1M context)', options: [] }],
      mode: 'live',
      dispatchCommand: vi.fn()
    })!

    await surface.setOption('model', 'opus[1m]')

    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'opus[1m]',
      choices: [{ value: 'opus[1m]', label: 'Opus (1M context)' }]
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

  it('names grok’s CLI default on load and still applies the rows it draws', async () => {
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: dispatch
    })!
    // Nothing tracked means no `-m` was emitted, so grok is on its own default.
    expect(surface.getSnapshot()[0]).toMatchObject({
      id: 'model',
      valueSource: 'default',
      kind: { currentValue: 'grok-4.6' }
    })

    // Regression: the effort row hangs off that default model, so resolving the apply
    // from the tracked model alone threw `Unknown session option: effort` on click.
    await surface.setOption('effort', 'low')

    expect(dispatch).toHaveBeenCalledWith('/effort low')
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'low' }
    })
  })

  it('does not adopt grok’s unprobed seed default as a persisted launch model', async () => {
    // Regression: setting an option under the CLI default wrote `model` into settings,
    // so every later grok launch app-wide emitted `-m grok-4.6` — on an account without
    // that model, a fatal launch the user never opted into. No discovery has run here,
    // so `grok-4.6` is still only the seed's guess.
    let persisted: PersistedNativeChatSessionOptions = {}
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) => {
        persisted = updateNativeChatSessionOptionDefaults({
          persisted,
          agent: 'grok',
          modelId,
          optionId,
          value,
          adoptModelAsLaunchDefault
        })
      }
    })!

    await surface.setOption('effort', 'low')

    expect(persisted.grok?.model).toBeUndefined()
    // The scoped value is still remembered for a later explicit pick of that model.
    expect(persisted.grok?.valuesByModel?.['grok-4.6']?.effort).toBe('low')
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'grok')).toBeUndefined()

    // A model the user actually picks still becomes the launch default.
    await surface.setOption('model', 'grok-4.5')
    expect(persisted.grok?.model).toBe('grok-4.5')
  })

  it('commits an effort grok accepted even when discovery lands mid-dispatch', async () => {
    // Regression: the staleness guard resolved through the model list, so a probe
    // settling mid-dispatch moved which row is `isDefault` and looked like a model
    // switch — discarding a value the agent had already applied.
    let release = (): void => {}
    let markDispatched = (): void => {}
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => resolve()
            markDispatched()
          })
      )
    })!

    const pending = surface.setOption('effort', 'low')
    await dispatched
    surface.replaceModels(
      mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        { id: 'grok-4.5', label: 'Grok 4.5', options: [] },
        { id: 'grok-5', label: 'Grok 5', isDefault: true, options: [] }
      ])
    )
    release()
    await pending

    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'low' }
    })
  })

  it('files a dispatched effort under the default the probe reported, not the seed guess', async () => {
    // With nothing tracked the session launched without `-m`, so it is running whatever
    // grok defaults to — a fact only `grok models` knows. The pre-dispatch id is the
    // seed's guess; committing under it would file the value against a model that was
    // never running and blank the pill the user just set.
    const persistSelection = vi.fn()
    let release = (): void => {}
    let markDispatched = (): void => {}
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey: 'pty-1',
      mode: 'live',
      persistSelection,
      dispatchCommand: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => resolve()
            markDispatched()
          })
      )
    })!

    const pending = surface.setOption('effort', 'low')
    await dispatched
    surface.replaceModels(
      mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        { id: 'grok-5', label: 'Grok 5', isDefault: true, options: [] },
        { id: 'grok-build', label: 'Grok Build', options: [] }
      ])
    )
    release()
    await pending

    expect(persistSelection).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'grok-5', optionId: 'effort', value: 'low' })
    )
    // A tracked model is returned verbatim by the resolver, so this re-resolution can
    // only ever move an untracked, never-selected id — never one the user picked. The
    // probe that landed mid-dispatch also confirmed grok-5, so it is safe to adopt.
    expect(persistSelection).toHaveBeenCalledWith(
      expect.objectContaining({ adoptModelAsLaunchDefault: true })
    )
  })

  it('carries an effort set under a probe-confirmed default into later launches', async () => {
    // Regression: the value persisted under the model id while `model` stayed unset, so
    // resolveNativeChatSessionOptionDefaults bailed and every new grok tab reverted to
    // the catalog default — the setting silently never survived a relaunch.
    let persisted: PersistedNativeChatSessionOptions = {}
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey: 'pty-1',
      mode: 'live',
      initialModels: mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        { id: 'grok-4.5', label: 'Grok 4.5', isDefault: true, options: [] }
      ]),
      dispatchCommand: vi.fn(),
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) => {
        persisted = updateNativeChatSessionOptionDefaults({
          persisted,
          agent: 'grok',
          modelId,
          optionId,
          value,
          adoptModelAsLaunchDefault
        })
      }
    })!

    await surface.setOption('effort', 'low')

    expect(persisted.grok?.model).toBe('grok-4.5')
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'grok')).toMatchObject({
      model: 'grok-4.5',
      effort: 'low'
    })
  })
})
