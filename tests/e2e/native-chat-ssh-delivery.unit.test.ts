import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSshDelivery,
  createPairedRuntime,
  sendMobilePermissionResponse,
  io
} from './__mocks__/native-chat-ssh-delivery'
import {
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  sendNativeChatMessageVerified,
  resetNativeChatPtySendQueuesForTests
} from '../../src/renderer/src/components/native-chat/native-chat-runtime-send'
import { buildAskAnswerKeys } from '../../src/shared/native-chat-ask'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import { sendAgentDraftPasteContentNow } from '../../src/renderer/src/lib/agent-draft-paste-content'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'

let close: (() => void) | undefined
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  close?.()
  close = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  io.rpc.mockReset()
})

describe('prompt delivery through production IPC, provider and paired host', () => {
  it('serializes every chunk of a healthy large SSH answer before Enter and dismissal', async () => {
    vi.useFakeTimers()
    const ssh = createSshDelivery('slow')
    close = ssh.close
    const text = `${'X'.repeat(32768)}TAIL`
    const groups = buildAskAnswerKeys(
      { questions: [{ question: 'Answer?', options: [{ label: 'A' }], multiSelect: false }] },
      [{ indices: [], other: text }]
    )
    const onSettled = vi.fn()
    sendNativeChatAskAnswer(ssh.id, groups, onSettled)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ssh.bytes).not.toContain('\r')
    expect(onSettled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    expect(ssh.bytes.join('')).toBe(
      groups.map((group) => ('raw' in group ? group.raw : group.text)).join('')
    )
    expect(ssh.bytes.findIndex((data) => data.includes('TAIL'))).toBeLessThan(
      ssh.bytes.indexOf('\r')
    )
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('cancels remaining paced groups while an already-issued body still settles', async () => {
    vi.useFakeTimers()
    const ssh = createSshDelivery('slow')
    close = ssh.close
    const onSettled = vi.fn()
    const handle = sendNativeChatAskAnswer(
      ssh.id,
      [{ text: `${'X'.repeat(32768)}TAIL` }, { raw: '\r' }],
      onSettled
    )
    await vi.advanceTimersByTimeAsync(500)
    handle.cancel()
    await vi.advanceTimersByTimeAsync(4000)
    expect(ssh.bytes.join('')).toBe(`${'X'.repeat(32768)}TAIL`)
    expect(ssh.bytes).not.toContain('\r')
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('keeps ordinary healthy SSH body and Enter complete', async () => {
    vi.useFakeTimers()
    const ssh = createSshDelivery()
    close = ssh.close
    const onDeliverySettled = vi.fn()
    sendNativeChatMessage(ssh.id, 'body', { onDeliverySettled })
    await vi.advanceTimersByTimeAsync(600)
    expect(ssh.bytes.join('')).toBe('\x15body\r')
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each(['accepted', 'lost'] as const)(
    'paired terminal.send uses provider settlement for %s acknowledgment',
    async (mode) => {
      const ssh = createSshDelivery(mode)
      close = ssh.close
      const { runtime, handle } = await createPairedRuntime(ssh)
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      io.rpc.mockImplementation(async (_target, method, params) => {
        const reply = await dispatcher.dispatch({
          id: 'send',
          authToken: 'token',
          method,
          params: { ...params, terminal: handle }
        })
        if (!reply.ok) {
          throw new Error(reply.error.message)
        }
        return reply.result
      })
      const pending = sendRuntimePtyInputVerified('remote:owner@@terminal', '\x1b', 'driving', {
        requireWriteSettlement: true
      })
      await (mode === 'accepted'
        ? expect(pending).resolves.toBe(true)
        : expect(pending).rejects.toThrow('acknowledgment unavailable'))
      expect(ssh.settlement).toHaveBeenCalledOnce()
      expect(ssh.bytes).toEqual(['\x1b'])
      expect(io.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'terminal.send',
        expect.objectContaining({ requireWriteSettlement: true }),
        expect.anything()
      )
    }
  )

  it('older paired hosts keep their whole-write verdict for answers and ordinary sequences', async () => {
    const ssh = createSshDelivery()
    close = ssh.close
    const { runtime, handle } = await createPairedRuntime(ssh)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    io.rpc.mockImplementation(async (_target, _method, params) => {
      // Older request schemas strip the optional requirement and perform the legacy write.
      const reply = await dispatcher.dispatch({
        id: 'legacy',
        authToken: 'token',
        method: 'terminal.send',
        params: { ...params, terminal: handle, requireWriteSettlement: undefined }
      })
      if (!reply.ok) {
        throw new Error(reply.error.message)
      }
      return reply.result
    })
    await expect(
      sendRuntimePtyInputVerified('remote:owner@@terminal', 'answer', 'driving', {
        requireWriteSettlement: true
      })
    ).resolves.toBe(true)
    await expect(sendNativeChatMessageVerified('remote:owner@@terminal', 'body')).resolves.toBe(
      true
    )
    await expect(
      sendAgentDraftPasteContentNow('remote:owner@@terminal', 'launch', 'launch')
    ).resolves.toBe(true)
    expect(ssh.bytes).toEqual(['answer', 'body', '\r', '\x1b[200~launch\x1b[201~'])
    expect(ssh.settlement).not.toHaveBeenCalled()
  })

  it('older paired hosts confirm ordinary chat sends and pasted answers as before', async () => {
    vi.useFakeTimers()
    io.rpc.mockResolvedValue({ send: { handle: 'terminal', accepted: true, bytesWritten: 1 } })
    const onWriteUnconfirmed = vi.fn()
    const onWriteRejected = vi.fn()
    sendNativeChatMessage('remote:owner@@terminal', 'hello', {
      onWriteRejected,
      onWriteUnconfirmed
    })
    const onDeliverySettled = vi.fn()
    sendNativeChatMessage('remote:owner@@terminal', 'answer', { onDeliverySettled })
    await vi.advanceTimersByTimeAsync(2000)
    expect(onWriteUnconfirmed).not.toHaveBeenCalled()
    expect(onWriteRejected).not.toHaveBeenCalled()
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('sends ordinary paired input without asking the host for provider settlement', async () => {
    io.rpc.mockResolvedValue({ send: { handle: 'terminal', accepted: true, bytesWritten: 4 } })
    await expect(
      sendRuntimePtyInputVerified('remote:owner@@terminal', 'body', 'driving')
    ).resolves.toBe(true)
    expect(io.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.not.objectContaining({ requireWriteSettlement: expect.anything() }),
      expect.anything()
    )
  })

  it.each(['accepted', 'lost', 'older-host'] as const)(
    'mobile permission send reads the actual paired %s verdict',
    async (mode) => {
      const ssh = createSshDelivery(mode === 'lost' ? 'lost' : 'accepted')
      close = ssh.close
      const { runtime, handle } = await createPairedRuntime(ssh)
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const client: RpcClient = {
        sendRequest: (method, params) =>
          dispatcher.dispatch({
            id: 'mobile',
            authToken: 'token',
            method,
            // An older host's schema strips the optional requirement.
            params:
              mode === 'older-host' && typeof params === 'object' && params !== null
                ? { ...params, requireWriteSettlement: undefined }
                : params
          }),
        subscribe: () => () => {},
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      await expect(
        sendMobilePermissionResponse({
          client,
          terminal: handle,
          deviceToken: null,
          text: '\x1b'
        })
      ).resolves.toBe(mode === 'lost' ? 'unknown' : 'accepted')
      expect(ssh.settlement).toHaveBeenCalledTimes(mode === 'older-host' ? 0 : 1)
      expect(ssh.bytes).toEqual(['\x1b'])
    }
  )

  it('finishes every older-host selector group once and settles the answer as delivered', async () => {
    vi.useFakeTimers()
    const ssh = createSshDelivery()
    close = ssh.close
    const { runtime, handle } = await createPairedRuntime(ssh)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    io.rpc.mockImplementation(async (_target, _method, params) => {
      const reply = await dispatcher.dispatch({
        id: 'legacy-selector',
        authToken: 'token',
        method: 'terminal.send',
        params: { ...params, terminal: handle, requireWriteSettlement: undefined }
      })
      if (!reply.ok) {
        throw new Error(reply.error.message)
      }
      return reply.result
    })
    const groups = buildAskAnswerKeys(
      { questions: [{ question: 'Answer?', options: [{ label: 'A' }], multiSelect: false }] },
      [{ indices: [], other: 'custom answer' }]
    )
    const onSettled = vi.fn()
    sendNativeChatAskAnswer('remote:owner@@terminal', groups, onSettled)
    await vi.advanceTimersByTimeAsync(4000)
    expect(ssh.bytes).toEqual(groups.map((group) => ('raw' in group ? group.raw : group.text)))
    expect(ssh.settlement).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
  })
})
