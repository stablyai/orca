// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const mocks = vi.hoisted(() => ({ call: vi.fn(), toastError: vi.fn(), enqueue: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: async () => true
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: () => null,
  getStructuredAgentSessionLaunchSelection: () => null
}))

const TARGET = { kind: 'local' } as const
const STATE = { current: { fence: 3 } }

beforeEach(() => vi.clearAllMocks())

describe.each(['claude', 'codex'] as const)('%s desktop permission write', (agent) => {
  it.each(['bypass', 'ask'] as const)(
    'keeps the confirmed label after a lost reply with host %s',
    async (afterWrite) => {
      let hostMode: AgentChatPermissionMode = 'bypass'
      let lostReply = true
      mocks.call.mockImplementation(async (_target: unknown, method: string) => {
        if (method === 'agentSession.options') {
          return {
            models: [{ id: 'model-1', label: 'Model', isDefault: true, efforts: [] }],
            current: { model: 'model-1' },
            permissionModes: { current: hostMode, supported: ['ask', 'auto', 'bypass'] }
          }
        }
        if (method === 'agentSession.setOption') {
          hostMode = afterWrite
          if (lostReply) {
            throw new Error('Reply lost')
          }
          hostMode = 'ask'
          return { ok: true, value: { key: 'permissionMode', value: 'ask' } }
        }
        return new Promise(() => {})
      })
      const { result, rerender, unmount } = renderHook(
        (props: { permissionMode: string }) => {
          const { mutate } = useStructuredAgentSessionMutate({
            sessionId: 'session-1',
            target: TARGET,
            stateRef: STATE
          })
          return useStructuredAgentSessionOptions({
            agent,
            sessionId: 'session-1',
            target: TARGET,
            transportEnabled: true,
            isVisible: true,
            providerVisible: true,
            fence: 3,
            turnId: null,
            permissionMode: props.permissionMode,
            unloadedTurnRevisions: undefined,
            mutate
          })
        },
        { initialProps: { permissionMode: 'bypass' } }
      )
      await waitFor(() =>
        expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
      )
      let applied: boolean | undefined
      await act(async () => {
        applied = await result.current.optionSurface.permissionPicker?.setMode('ask')
      })
      expect(applied).toBe(false)
      expect(result.current.optionSurface.permissionPicker).toMatchObject({
        provider: agent,
        current: 'bypass',
        pending: false,
        disabled: false
      })
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
        "Orca couldn't confirm what happened. Check the chat."
      )
      if (afterWrite === 'ask') {
        rerender({ permissionMode: 'ask' })
        await waitFor(() =>
          expect(result.current.optionSurface.permissionPicker?.current).toBe('ask')
        )
      }
      lostReply = false
      await act(async () => {
        applied = await result.current.optionSurface.permissionPicker?.setMode('ask')
      })
      expect(applied).toBe(true)
      expect(result.current.optionSurface.permissionPicker?.current).toBe('ask')
      expect(mocks.enqueue).not.toHaveBeenCalled()
      unmount()
    }
  )
})
