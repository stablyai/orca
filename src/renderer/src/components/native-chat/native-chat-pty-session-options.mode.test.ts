import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'

describe('native chat PTY session options — permission mode', () => {
  beforeEach(() => {
    clearNativeChatSessionOptionCacheForTests()
  })

  it('wires a permission-mode cycle selection to dispatchModeCycle', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'claude', { model: 'opus' })
    const dispatchModeCycle = vi
      .fn()
      .mockResolvedValue({ outcome: 'applied', reason: 'reached', presses: 1, observed: ['plan'] })
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      dispatchModeCycle
    })!

    const result = await surface.setOption('permissionMode', 'plan')

    expect(dispatchModeCycle).toHaveBeenCalledWith({ key: '\x1b[Z', target: 'plan' })
    expect(result.snapshot.find(({ id }) => id === 'permissionMode')).toMatchObject({
      valueSource: 'applied',
      kind: { currentValue: 'plan' }
    })
  })

  it('rejects a permission-mode change when no dispatchModeCycle is wired', async () => {
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
    await expect(surface.setOption('permissionMode', 'plan')).rejects.toThrow(
      'No live terminal is attached to this chat.'
    )
  })

  it('threads agentArgs into the snapshot: bypass is normal and checkmarked when the flag is present', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      agentArgs: '--dangerously-skip-permissions'
    })!
    const permissionMode = surface.getSnapshot().find(({ id }) => id === 'permissionMode')
    expect(permissionMode?.kind).toMatchObject({ currentValue: 'bypassPermissions' })
    const bypass =
      permissionMode?.kind.type === 'select'
        ? permissionMode.kind.choices.find((choice) => choice.value === 'bypassPermissions')
        : undefined
    expect(bypass?.unavailable).toBeUndefined()
  })

  it('threads agentArgs into the snapshot: bypass is unavailable without the flag', () => {
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      agentArgs: '--model sonnet'
    })!
    const permissionMode = surface.getSnapshot().find(({ id }) => id === 'permissionMode')
    const bypass =
      permissionMode?.kind.type === 'select'
        ? permissionMode.kind.choices.find((choice) => choice.value === 'bypassPermissions')
        : undefined
    expect(bypass?.unavailable).toEqual({ action: 'open-agent-permissions-setting' })
    expect(permissionMode?.kind).not.toHaveProperty('currentValue')
  })
})
