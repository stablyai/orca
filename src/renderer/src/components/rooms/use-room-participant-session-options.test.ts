// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useRoomParticipantSessionOptions } from './use-room-participant-session-options'

const target = { kind: 'local' } as const

function participant(terminalHandle: string | null): RoomParticipant {
  return {
    id: 'participant',
    agent: 'codex',
    worktreeId: null,
    terminalHandle,
    context: { model: 'gpt-5.6-sol', effort: 'high', fastMode: false }
  } as RoomParticipant
}

describe('useRoomParticipantSessionOptions', () => {
  it('refreshes provider availability after a remote machine option changes', async () => {
    const remote = { kind: 'environment', environmentId: 'ssh-host' } as const
    let enabled = false
    const fast = () => ({
      id: 'fastMode',
      label: 'Fast mode',
      kind: { type: 'boolean', currentValue: enabled },
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true,
      ...(enabled ? { description: 'Cooldown' } : {})
    })
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        enabled = true
        return Promise.resolve({ ok: true, value: { options: { fastMode: 'true' } } })
      }
      return Promise.resolve(
        method === 'agentSession.options'
          ? { models: [], current: { model: 'opus' }, descriptors: [fast()] }
          : { page: { items: [], fence: 4 } }
      )
    })
    const machine = {
      ...participant(null),
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-1', transport: 'machine' }
    } as RoomParticipant
    const { result } = renderHook(() => useRoomParticipantSessionOptions(machine, remote))
    await waitFor(() => expect(result.current.surface).not.toBeNull())
    await act(() => result.current.surface!.setOption('fastMode', true))
    expect(result.current.snapshot).toEqual([fast()])
    expect(result.current.snapshot[0]?.description).toBe('Cooldown')
    expect(mocks.call.mock.calls.every(([target]) => target === remote)).toBe(true)
    expect(mocks.call).toHaveBeenCalledWith(
      remote,
      'agentSession.setOption',
      expect.objectContaining({
        key: 'fastMode',
        value: 'true',
        envelope: expect.objectContaining({ expectedRuntimeFence: 4 })
      })
    )
  })

  beforeEach(() => {
    mocks.call.mockReset()
  })

  it('preserves the option surface when a restored participant gets a new handle', () => {
    const { result, rerender } = renderHook(
      ({ terminalHandle }) => useRoomParticipantSessionOptions(participant(terminalHandle), target),
      { initialProps: { terminalHandle: 'old-handle' as string | null } }
    )
    const original = result.current.surface

    rerender({ terminalHandle: 'restored-handle' })
    expect(result.current.surface).toBe(original)

    rerender({ terminalHandle: null })
    expect(result.current.surface).toBeNull()

    rerender({ terminalHandle: 'new-session-handle' })
    expect(result.current.surface).not.toBe(original)
  })

  it('reloads machine options after a sleeping provider is started', async () => {
    let ready = false
    const descriptor = {
      id: 'model',
      label: 'Model',
      category: 'model' as const,
      kind: {
        type: 'select' as const,
        currentValue: 'gpt-5.6-sol',
        choices: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }]
      },
      valueSource: 'reported' as const,
      settable: true
    }
    mocks.call.mockImplementation((_target, method) => {
      if (!ready) {
        return Promise.reject(new Error('provider sleeping'))
      }
      return Promise.resolve(
        method === 'agentSession.options'
          ? { models: [], current: { model: 'gpt-5.6-sol' }, descriptors: [descriptor] }
          : { page: { items: [], fence: 4 } }
      )
    })
    const machineParticipant = {
      ...participant(null),
      providerSession: { key: 'session_id', id: 'session-1', transport: 'machine' }
    } as RoomParticipant
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() =>
      useRoomParticipantSessionOptions(machineParticipant, target)
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())

    ready = true
    await act(() => result.current.refreshMachineOptions())

    expect(result.current.snapshot).toEqual([descriptor])
    expect(result.current.surface).not.toBeNull()
    warn.mockRestore()
  })
})
