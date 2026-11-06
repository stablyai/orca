// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { NativeChatTerminalQueueRequest } from '../../../../shared/native-chat/native-chat-terminal-queue'
import { useNativeChatTerminalQueue } from './use-native-chat-terminal-queue'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyOwner: () => ({ target: { kind: 'local' }, terminal: 'term' })
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
afterEach(() => rpc.mockReset())

describe('desktop terminal queue acknowledgment', () => {
  it.each(['forbidden', 'runtime_timeout', 'transport'])(
    'distinguishes definite refusal from an ambiguous %s outcome',
    async (code) => {
      rpc.mockImplementation(async (_target, _method, params) => {
        if (NativeChatTerminalQueueRequest.parse(params).action.type === 'enqueue') {
          if (code === 'transport') {
            throw new Error('connection closed')
          }
          throw new RuntimeRpcCallError({
            id: 'request',
            ok: false,
            error: { code, message: code },
            _meta: { runtimeId: 'runtime' }
          })
        }
        return {
          revision: '0',
          activity: { state: 'idle', workingSequence: 0 },
          queuedMessages: []
        }
      })
      const hook = renderHook(() =>
        useNativeChatTerminalQueue({
          paneKey: 'tab:leaf',
          ptyId: 'pty',
          enabled: true,
          environmentId: null,
          composerRef: createRef<NativeChatComposerHandle>()
        })
      )
      try {
        await act(async () => {
          await (code === 'forbidden'
            ? expect(hook.result.current.enqueue('hello')).resolves.toBe(false)
            : expect(hook.result.current.enqueue('hello')).rejects.toThrow())
        })
        expect(
          rpc.mock.calls.filter(
            (call) => NativeChatTerminalQueueRequest.parse(call[2]).action.type === 'enqueue'
          )
        ).toHaveLength(1)
      } finally {
        hook.unmount()
      }
    }
  )

  it('hides the held snapshot until a fresh read returns after reconnect', async () => {
    const reads: ((value: unknown) => void)[] = []
    rpc.mockImplementation(async (_target, method, params) => {
      if (method !== 'nativeChat.terminalQueue') {
        return { terminal: { handle: 'term' } }
      }
      const { action } = NativeChatTerminalQueueRequest.parse(params)
      if (action.type !== 'read') {
        return null
      }
      return new Promise((resolve) => {
        reads.push(resolve)
      })
    })
    const hook = renderHook(
      ({ enabled }) =>
        useNativeChatTerminalQueue({
          paneKey: 'tab:leaf',
          ptyId: 'pty',
          enabled,
          environmentId: null,
          composerRef: createRef<NativeChatComposerHandle>()
        }),
      { initialProps: { enabled: true } }
    )
    try {
      await act(async () => {
        await vi.waitFor(() => {
          expect(reads.length).toBeGreaterThan(0)
        })
        reads.shift()?.({
          revision: '1',
          activity: { state: 'working', workingSequence: 1 },
          queuedMessages: [
            {
              messageId: '11111111-1111-4111-8111-111111111111',
              position: 1,
              state: 'waiting',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Held' }] }
            }
          ]
        })
      })
      expect(hook.result.current.activity?.state).toBe('working')
      expect(hook.result.current.controller.cards).toHaveLength(1)
      await act(async () => {
        hook.rerender({ enabled: false })
      })
      expect(hook.result.current.activity).toBeUndefined()
      expect(hook.result.current.controller.cards).toEqual([])
      await act(async () => {
        hook.rerender({ enabled: true })
      })
      expect(hook.result.current.activity).toBeUndefined()
      expect(hook.result.current.controller.cards).toEqual([])
    } finally {
      hook.unmount()
    }
  })

  it('discards a read that resolves after the queue was disabled', async () => {
    const reads: ((value: unknown) => void)[] = []
    rpc.mockImplementation(async (_target, method, params) => {
      if (method !== 'nativeChat.terminalQueue') {
        return { terminal: { handle: 'term' } }
      }
      const { action } = NativeChatTerminalQueueRequest.parse(params)
      if (action.type !== 'read') {
        return null
      }
      return new Promise((resolve) => {
        reads.push(resolve)
      })
    })
    const hook = renderHook(
      ({ enabled }) =>
        useNativeChatTerminalQueue({
          paneKey: 'tab:leaf',
          ptyId: 'pty',
          enabled,
          environmentId: null,
          composerRef: createRef<NativeChatComposerHandle>()
        }),
      { initialProps: { enabled: true } }
    )
    try {
      await act(async () => {
        await vi.waitFor(() => {
          expect(reads.length).toBeGreaterThan(0)
        })
      })
      await act(async () => {
        hook.rerender({ enabled: false })
      })
      await act(async () => {
        hook.rerender({ enabled: true })
      })
      await act(async () => {
        reads.shift()?.({
          revision: '1',
          activity: { state: 'working', workingSequence: 1 },
          queuedMessages: [
            {
              messageId: '11111111-1111-4111-8111-111111111111',
              position: 1,
              state: 'waiting',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Stale' }] }
            }
          ]
        })
      })
      expect(hook.result.current.activity).toBeUndefined()
      expect(hook.result.current.controller.cards).toEqual([])
    } finally {
      hook.unmount()
    }
  })

  it('keeps an enqueue acknowledgment that arrives after disable', async () => {
    const reads: ((value: unknown) => void)[] = []
    rpc.mockImplementation(async (_target, method, params) => {
      if (method !== 'nativeChat.terminalQueue') {
        return { terminal: { handle: 'term' } }
      }
      NativeChatTerminalQueueRequest.parse(params)
      return new Promise((resolve) => {
        reads.push(resolve)
      })
    })
    const snapshot = {
      revision: '1',
      activity: { state: 'idle', workingSequence: 1 },
      queuedMessages: []
    }
    const hook = renderHook(
      ({ enabled }) =>
        useNativeChatTerminalQueue({
          paneKey: 'tab:leaf',
          ptyId: 'pty',
          enabled,
          environmentId: null,
          composerRef: createRef<NativeChatComposerHandle>()
        }),
      { initialProps: { enabled: true } }
    )
    try {
      await act(async () => {
        await vi.waitFor(() => {
          expect(reads.length).toBeGreaterThan(0)
        })
        reads.shift()?.(snapshot)
      })
      let pending: Promise<boolean> | undefined
      await act(async () => {
        pending = hook.result.current.enqueue('Later')
        await vi.waitFor(() => {
          expect(reads.length).toBeGreaterThan(0)
        })
      })
      await act(async () => {
        hook.rerender({ enabled: false })
      })
      await act(async () => {
        reads.shift()?.(snapshot)
        await expect(pending).resolves.toBe(true)
      })
      expect(hook.result.current.controller.cards).toEqual([])
      expect(hook.result.current.activity).toBeUndefined()
    } finally {
      hook.unmount()
    }
  })
})
