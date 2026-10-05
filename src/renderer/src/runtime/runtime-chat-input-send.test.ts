import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimeChatInput, type RuntimeChatInputAction } from './runtime-chat-input-send'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { useAppStore } from '../store'

function action(hostGuarded = true): RuntimeChatInputAction & { onRefused: () => void } {
  return { actionId: 'chat-1', hostGuarded, refused: false, onRefused: vi.fn() }
}

describe('sendRuntimeChatInput', () => {
  const runtimeCall = vi.fn()
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()
  const localWriteChatInput = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 5 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: (args: RuntimeEnvironmentCallRequest) =>
            createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
        },
        pty: {
          write: localWrite,
          writeAccepted: localWriteAccepted,
          writeChatInput: localWriteChatInput
        }
      }
    })
    useAppStore.setState({ terminalLayoutsByTabId: {}, lastTerminalInputAtByPaneKey: {} })
  })

  it('never falls back to a raw write when the local host refuses a chat write', async () => {
    localWriteChatInput.mockResolvedValue({
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'agent-exited'
    })
    const step = action()

    await expect(
      sendRuntimeChatInput(null, 'local-pty', 'hello', 'driving', step)
    ).resolves.toEqual({ accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' })

    expect(localWriteChatInput).toHaveBeenCalledWith('local-pty', 'hello', 'driving', 'chat-1')
    expect(localWrite).not.toHaveBeenCalled()
    expect(localWriteAccepted).not.toHaveBeenCalled()
    expect(step.onRefused).toHaveBeenCalledOnce()
    // Later steps of the refused action are never dispatched.
    await sendRuntimeChatInput(null, 'local-pty', '\r', 'driving', step)
    expect(localWriteChatInput).toHaveBeenCalledTimes(1)
  })

  it('sends a local SSH-owned chat write through the guarded IPC and accepts its settlement', async () => {
    localWriteChatInput.mockResolvedValue({ accepted: true, bytesWritten: 5 })
    await expect(
      sendRuntimeChatInput(null, 'ssh:conn-1@@pty-7', 'hello', 'driving', action())
    ).resolves.toEqual({ accepted: true, bytesWritten: 5 })
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('reports a lost settlement as delivery-unknown without calling it a refusal', async () => {
    localWriteChatInput.mockResolvedValue({
      accepted: false,
      bytesWritten: 3,
      deliveryUnknown: true
    })
    const step = action()
    await expect(
      sendRuntimeChatInput(null, 'local-pty', 'hello', 'driving', step)
    ).resolves.toMatchObject({ deliveryUnknown: true, bytesWritten: 3 })
    expect(step.onRefused).not.toHaveBeenCalled()
    expect(step.refused).toBe(false)
  })

  it('tags a paired write only for a host that advertises the guard', async () => {
    await sendRuntimeChatInput(null, 'remote:env-1@@terminal-1', 'x', 'driving', action(true))
    await sendRuntimeChatInput(null, 'remote:env-1@@terminal-1', 'y', 'driving', action(false))

    const params = runtimeCall.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === 'terminal.send')
      .map((request) => request.params)
    expect(params).toEqual([
      {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'orca-desktop', type: 'desktop' },
        chatInput: { actionId: 'chat-1' }
      },
      { terminal: 'terminal-1', text: 'y', client: { id: 'orca-desktop', type: 'desktop' } }
    ])
  })

  it("surfaces a paired host's agent-exited refusal once", async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        send: {
          handle: 'terminal-1',
          accepted: false,
          bytesWritten: 0,
          refusedReason: 'agent-exited'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const step = action()
    await expect(
      sendRuntimeChatInput(null, 'remote:env-1@@terminal-1', 'x', 'driving', step)
    ).resolves.toEqual({ accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' })
    expect(step.onRefused).toHaveBeenCalledOnce()
  })

  it('keeps a body ahead of its Enter even while the body is still being measured (R1B-2)', async () => {
    const order: string[] = []
    localWriteChatInput.mockImplementation(async (_ptyId: string, data: string) => {
      order.push(data.length > 10 ? 'body' : JSON.stringify(data))
      return { accepted: true, bytesWritten: data.length }
    })
    const step = action()
    const body = sendRuntimeChatInput(null, 'local-pty', 'x'.repeat(300_000), 'driving', step)
    const enter = sendRuntimeChatInput(null, 'local-pty', '\r', 'driving', step)
    await Promise.all([body, enter])
    expect(order).toEqual(['body', '"\\r"'])
  })

  it('writes nothing until a pending switch commits chat, and refuses when it does not', async () => {
    localWriteChatInput.mockResolvedValue({ accepted: true, bytesWritten: 5 })
    let commit: (value: boolean) => void = () => {}
    const pending = action()
    pending.ready = new Promise<boolean>((resolve) => {
      commit = resolve
    })
    const sent = sendRuntimeChatInput(null, 'local-pty', 'hello', 'driving', pending)
    await Promise.resolve()
    expect(localWriteChatInput).not.toHaveBeenCalled()
    commit(true)
    await expect(sent).resolves.toMatchObject({ accepted: true })

    const normalized = action()
    normalized.ready = Promise.resolve(false)
    await expect(
      sendRuntimeChatInput(null, 'local-pty', 'hello', 'driving', normalized)
    ).resolves.toEqual({ accepted: false, bytesWritten: 0 })
    expect(normalized.onRefused).toHaveBeenCalledWith({ nothingWritten: true })
    expect(localWriteChatInput).toHaveBeenCalledTimes(1)
  })
})
