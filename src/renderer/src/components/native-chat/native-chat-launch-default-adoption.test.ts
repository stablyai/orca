import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from '../../../../shared/native-chat-pty-session-options'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type {
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from '../../../../shared/native-chat/input/native-chat-session-options'

describe('native chat launch-default adoption', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  // Model a host catalog that adds opus[1m] and drops the seeded opus id.
  const HOST_CLAUDE_MODELS = [
    { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
    { id: 'sonnet', label: 'Sonnet', options: [] }
  ]

  /** Apply picker persistence through settings so assertions see flags emitted for later chats. */
  const claudeLaunchDefaults = (): {
    read: () => PersistedNativeChatSessionOptions
    persistSelection: (args: {
      modelId: string
      optionId: string
      value: SessionOptionValue
      adoptModelAsLaunchDefault: boolean
    }) => void
  } => {
    let persisted: PersistedNativeChatSessionOptions = {}
    return {
      read: () => persisted,
      persistSelection: (args) => {
        persisted = updateNativeChatSessionOptionDefaults({ persisted, agent: 'claude', ...args })
      }
    }
  }

  it('does not adopt a launch-flag model no list carries as the persisted launch default', async () => {
    // Tracking an emitted launch flag does not validate its model id; unlisted ids must not become persisted defaults.
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'claude-opus-5' })
    const defaults = claudeLaunchDefaults()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      initialModels: HOST_CLAUDE_MODELS,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn().mockResolvedValue({ outcome: 'applied' }),
      persistSelection: defaults.persistSelection
    })!

    await surface.setOption('model', 'claude-opus-5')

    expect(defaults.read().claude?.model).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults(defaults.read(), 'claude')).toBeUndefined()
  })

  it('does not adopt an unlisted launch-flag model before discovery either', async () => {
    // A tracked flag proves emission, not that a catalog recognizes the model.
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'claude-opus-5' })
    const defaults = claudeLaunchDefaults()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn().mockResolvedValue({ outcome: 'applied' }),
      persistSelection: defaults.persistSelection
    })!

    await surface.setOption('model', 'claude-opus-5')

    expect(defaults.read().claude?.model).toBeUndefined()
  })

  it('still adopts a model only the host catalog lists', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'sonnet' })
    const defaults = claudeLaunchDefaults()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      initialModels: HOST_CLAUDE_MODELS,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn().mockResolvedValue({ outcome: 'applied' }),
      persistSelection: defaults.persistSelection
    })!

    await surface.setOption('model', 'opus[1m]')

    expect(defaults.read().claude?.model).toBe('opus[1m]')
  })

  it('still adopts a seeded alias the host catalog has stopped listing', async () => {
    // `opus` is a real model the seed vouches for, and this catalog is not authoritative,
    // so a CLI that lists only `opus[1m]` is no evidence against it.
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'opus', effort: 'xhigh' })
    const defaults = claudeLaunchDefaults()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      initialModels: HOST_CLAUDE_MODELS,
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn(),
      persistSelection: defaults.persistSelection
    })!

    await surface.setOption('effort', 'high')

    expect(resolveNativeChatSessionOptionDefaults(defaults.read(), 'claude')).toMatchObject({
      model: 'opus',
      effort: 'high'
    })
  })

  it('still adopts a tracked seed model before any discovery', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'opus', effort: 'xhigh' })
    const defaults = claudeLaunchDefaults()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      modelLabel: 'Model',
      dispatchCommand: vi.fn(),
      persistSelection: defaults.persistSelection
    })!

    await surface.setOption('effort', 'high')

    expect(defaults.read().claude?.model).toBe('opus')
  })
})
