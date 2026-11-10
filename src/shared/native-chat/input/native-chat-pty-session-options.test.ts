import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { mergeDiscoveredAuthoritativeModels } from '../../agent-session/options/agent-session-option-catalog'
import { GROK_SESSION_OPTION_CATALOG } from '../../agent-session/options/agent-session-option-catalog-grok'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'

describe('native chat PTY session options', () => {
  let scopeKey: string
  beforeEach(() => {
    scopeKey = `native-chat-pty-session-options-test:${randomUUID()}`
  })

  it('keeps the prior model and persistence when Claude rejects the switch', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'fable',
      effort: 'high'
    })
    const persist = vi.fn()
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
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
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'fable',
      effort: 'high'
    })
    const persist = vi.fn()
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
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
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'opus',
      effort: 'high'
    })
    const dispatch = vi.fn()
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
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
    expect(dispatch).toHaveBeenCalledWith('/fast')
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'unknown',
      action: { type: 'toggle-command' }
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it('no-ops a known toggle at the same absolute target (flip is not set-to-value)', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'opus',
      effort: 'high',
      fastMode: true
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch
    })!

    await surface.setOption('fastMode', false)
    dispatch.mockClear()
    // Retrying flip-only commands can invert an already applied value.
    const result = await surface.setOption('fastMode', false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.snapshot.find(({ id }) => id === 'fastMode')).toMatchObject({
      valueSource: 'applied',
      kind: { type: 'boolean', currentValue: false }
    })
  })

  it('serializes concurrent setOption calls so later writes win in order', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
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
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch
    })!

    const first = surface.setOption('fastMode', false)
    const second = surface.setOption('effort', 'low')
    // Wait for the microtask-queued applier to dispatch before testing serialization.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
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

  it('does not write flip state onto a model that changed mid-dispatch', async () => {
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
    surface.recordOutgoingCommand('/model sonnet')
    resolveDispatch?.()
    await pending
    expect(surface.getSnapshot().find(({ id }) => id === 'model')).toMatchObject({
      kind: { currentValue: 'sonnet' }
    })
    // An aborted flip must preserve both source and destination model buckets.
    const cached = readNativeChatSessionOptionCache(scopeKey)
    expect(cached?.valuesByModel.sonnet?.fastMode).toBeUndefined()
    expect(cached?.valuesByModel.opus?.fastMode).toMatchObject({
      value: true,
      source: 'applied'
    })
  })

  it('does not commit a non-flip option onto a model that changed mid-dispatch', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
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
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: dispatch,
      persistSelection: persist
    })!

    const pending = surface.setOption('effort', 'xhigh')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    // A model switch during dispatch must supersede the pending effort write.
    surface.recordOutgoingCommand('/model sonnet')
    resolveDispatch?.()
    await pending

    // Aborted effort writes must preserve both model buckets and persisted defaults.
    const cached = readNativeChatSessionOptionCache(scopeKey)
    expect(cached?.valuesByModel.sonnet?.effort).toBeUndefined()
    expect(cached?.valuesByModel.opus?.effort).toMatchObject({
      value: 'high',
      source: 'applied'
    })
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ optionId: 'effort', modelId: 'sonnet' })
    )
  })

  it('switches to the terminal and drops stale truth for a typed picker command', () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'opus',
      effort: 'xhigh'
    })
    const onAgentPicker = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn(),
      onAgentPicker
    })!

    surface.recordOutgoingCommand('/model')

    expect(onAgentPicker).toHaveBeenCalledOnce()
    expect(surface.getSnapshot()).toHaveLength(1)
    expect(surface.getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('passes an unknown persisted model through as a literal choice', async () => {
    seedNativeChatAppliedSessionOptions(scopeKey, 'claude', {
      model: 'future-model'
    })
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey,
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
      expectedChoiceLabel: 'Future Model'
    })
  })

  it('does not adopt grok’s unprobed seed default as a persisted launch model', async () => {
    // An unprobed seed default must not become a fatal app-wide -m flag after an effort pick.
    let persisted: PersistedNativeChatSessionOptions = {}
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
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
    expect(persisted.grok?.valuesByModel?.['grok-4.7']?.effort).toBe('low')
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'grok')).toBeUndefined()

    await surface.setOption('model', 'grok-4.5')
    expect(persisted.grok?.model).toBe('grok-4.5')
  })

  it('files a dispatched effort under the default the probe reported, not the seed guess', async () => {
    // Without -m the CLI uses its real default; discovery must replace the seed guess before storing effort.
    const persistSelection = vi.fn()
    let release = (): void => {}
    let markDispatched = (): void => {}
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'grok',
      scopeKey,
      mode: 'live',
      modelLabel: 'Model',
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
    // Re-resolution may move only untracked ids; the probe-confirmed default is safe to adopt.
    expect(persistSelection).toHaveBeenCalledWith(
      expect.objectContaining({ adoptModelAsLaunchDefault: true })
    )
  })
})
