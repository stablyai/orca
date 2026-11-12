// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'

const mocks = vi.hoisted(() => ({
  supported: true,
  rpc: vi.fn(),
  cancel: vi.fn(),
  idle: vi.fn(),
  legacy: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => (mocks.supported ? ['terminal.model-control.v1'] : [])
}))
vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => null
}))
vi.mock('../../terminal/send/native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: mocks.cancel,
  waitForNativeChatPtyIdle: mocks.idle
}))
vi.mock('../../terminal/send/native-chat-runtime-send', () => ({
  typeNativeChatCommand: mocks.legacy,
  sendNativeChatMessageVerified: mocks.legacy
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const intent = { kind: 'picker' as const, optionId: 'model' }

describe('desktop host model control dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supported = true
    mocks.idle.mockResolvedValue(undefined)
    mocks.legacy.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (_target, method) =>
      method === 'terminal.resolvePane'
        ? { terminal: { ptyId: 'pty', handle: 'handle', incarnationId: 'incarnation' } }
        : { control: { outcome: 'blocked', agent: 'codex', reason: 'foreign-draft' } }
    )
  })

  function mount() {
    const submitted = vi.fn()
    const recorded = vi.fn()
    const hook = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'codex',
        disabled: false,
        resolveTarget: () => ({ ptyId: 'pty', paneKey: 'pane' }),
        onSubmitted: submitted,
        onSlashCommand: recorded
      })
    )
    return { ...hook, submitted, recorded }
  }

  it('keeps blocked options away from submit cleanup and legacy input', async () => {
    const hook = mount()
    await act(async () => {
      expect(await hook.result.current.dispatch('/model', { intent })).toEqual({
        outcome: 'blocked',
        agent: 'codex',
        reason: 'foreign-draft'
      })
    })
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('pty', true)
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(hook.submitted).not.toHaveBeenCalled()
    expect(hook.recorded).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('never replays a control whose reply was lost', async () => {
    mocks.rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { ptyId: 'pty', handle: 'handle' } }
      }
      throw new Error('connection lost after handoff')
    })
    const hook = mount()
    await act(async () => {
      expect(await hook.result.current.dispatch('/model', { intent })).toEqual({
        outcome: 'unknown'
      })
    })
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(hook.submitted).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('uses the original route once for a proven missing method', async () => {
    mocks.rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { ptyId: 'pty', handle: 'handle' } }
      }
      throw new RuntimeRpcCallError({
        ok: false,
        id: 'control',
        error: { code: 'method_not_found', message: 'unsupported' }
      })
    })
    const hook = mount()
    await act(async () => {
      await hook.result.current.dispatch('/model', { intent })
    })
    expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith('pty', '/model', expect.any(AbortSignal))
    expect(hook.submitted).toHaveBeenCalledOnce()
    hook.unmount()
  })
})
