import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../../shared/agent-session-wire'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session-permission-modes-capability'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), write: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const mutate: StructuredAgentSessionMutate = vi.fn(async () => null)
afterEach(() => {
  forgetStructuredSessionSelection('session-1', LOCAL_TARGET)
  setLocalRuntimeCapabilitiesForTests(null)
})
beforeEach(() => {
  mocks.write.mockReset().mockImplementation(async ({ key, value }) => acceptedReply(key, value))
})
const LOCAL_TARGET = { kind: 'local' } as const

function acceptedReply(
  key: string,
  value: string
): AgentSessionMutationResult<AgentSessionOptionResult> {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'permission-test', sequence: 1 },
    value: { key, value, options: { [key]: value } }
  }
}

function optionsAnswering(...modes: (string | undefined)[]): void {
  let read = 0
  mocks.call.mockImplementation((_target: unknown, method: string, argumentsForWrite: unknown) => {
    if (method === 'agentSession.setOption') {
      return mocks.write(argumentsForWrite)
    }
    if (method !== 'agentSession.options') {
      return new Promise(() => {})
    }
    const permissionMode = modes[Math.min(read++, modes.length - 1)]
    return Promise.resolve({
      models: [{ id: 'model-a', label: 'Model A', isDefault: true, efforts: [] }],
      current: { model: 'model-a', ...(permissionMode ? { permissionMode } : {}) }
    })
  })
}

const optionReads = () =>
  mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length

function permission(snapshot: readonly SessionOptionDescriptor[]): string | null | undefined {
  const entry = snapshot.find((descriptor) => descriptor.id === 'permissionMode')
  return entry?.kind.type === 'select' ? entry.kind.currentValue : null
}

function renderReopened(fence: number, agent: 'codex' | 'claude' = 'codex') {
  return renderHook(
    (props: { fence: number; stamp: string }) =>
      useStructuredAgentSessionOptions({
        agent,
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: props.fence,
        turnId: null,
        unloadedTurnRevisions: undefined,
        hostOptionStamp: props.stamp,
        mutate
      }),
    { initialProps: { fence, stamp: 'model-a|ask' } }
  )
}

describe('the permission mode another device picks', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY])
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('re-reads the options once when the host status moves, and shows the new mode', async () => {
    optionsAnswering('ask', 'full-access')
    const { result, rerender, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))
    expect(optionReads()).toBe(1)

    rerender({ fence: 1, stamp: 'model-a|full-access' })
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('full-access'))
    expect(optionReads()).toBe(2)
    unmount()
  })

  it('keeps the mode across a fence of the same chat', async () => {
    optionsAnswering('auto')
    const { result, rerender, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('auto'))

    mocks.call.mockImplementation(() => new Promise(() => {}))
    rerender({ fence: 2, stamp: 'model-a|ask' })
    expect(permission(result.current.optionSnapshot)).toBe('auto')
    unmount()
  })

  it('waits for the new child’s report after an own-settings chat restarts', async () => {
    optionsAnswering('own')
    const read = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation(async (...args) => {
      const answer = await read(...args)
      return { ...answer, current: { ...answer.current, reportedPermissionMode: 'full-access' } }
    })
    const { result, rerender, unmount } = renderReopened(1)
    const row = () => result.current.optionSnapshot.find((entry) => entry.id === 'permissionMode')
    await waitFor(() => expect(row()).toMatchObject({ description: 'Full access', settable: true }))
    mocks.call.mockImplementation(() => new Promise(() => {}))
    rerender({ fence: 2, stamp: 'model-a|own' })
    expect(row()).toMatchObject({ description: 'Permissions', settable: false })
    unmount()
  })

  it('shows no picker for a host that states no mode', async () => {
    optionsAnswering(undefined)
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(optionReads()).toBe(1))
    await waitFor(() =>
      expect(result.current.optionSnapshot.some((descriptor) => descriptor.id === 'model')).toBe(
        true
      )
    )
    expect(permission(result.current.optionSnapshot)).toBeNull()
    unmount()
  })
})

describe('a permission pick on this device', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY])
    mocks.call.mockReset()
    vi.mocked(mutate).mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('writes an explicit per-chat pick matching the report without changing agent settings', async () => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
      AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
    ])
    optionsAnswering('own')
    const read = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((target, method, params) =>
      method === 'agentSession.options'
        ? Promise.resolve({
            models: [{ id: 'model-a', label: 'Model A', isDefault: true, efforts: [] }],
            current: {
              model: 'model-a',
              permissionMode: 'own',
              reportedPermissionMode: 'full-access'
            }
          })
        : read(target, method, params)
    )
    vi.mocked(enqueueSessionOptionSettingsWrite).mockClear()
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('full-access'))
    await act(async () => {
      expect(await result.current.setStructuredOption('permissionMode', 'full-access')).toBe(true)
    })
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        envelope: expect.objectContaining({ sessionId: 'session-1', expectedRuntimeFence: 1 }),
        key: 'permissionMode',
        value: 'full-access'
      })
    )
    expect(mutate).not.toHaveBeenCalled()
    expect(enqueueSessionOptionSettingsWrite).not.toHaveBeenCalled()
    unmount()
  })

  it('a PR2 client never sends own to a PR1 host', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY])
    optionsAnswering('ask')
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))
    expect(await result.current.setStructuredOption('permissionMode', 'own')).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
    unmount()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it('dispatches supported Own reset without locking permission or the next model pick', async () => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
      AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
    ])
    optionsAnswering('ask')
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))
    const reply = Promise.withResolvers<AgentSessionMutationResult<AgentSessionOptionResult>>()
    mocks.write.mockReturnValueOnce(reply.promise)
    let picking!: Promise<boolean>
    act(() => {
      picking = result.current.setStructuredOption('permissionMode', 'own')
    })
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: 'permissionMode',
        value: 'own',
        envelope: expect.objectContaining({ expectedRuntimeFence: 1 })
      })
    )
    expect(result.current.optionSnapshot.find((row) => row.id === 'model')?.settable).toBe(true)
    await act(async () => {
      reply.resolve(acceptedReply('permissionMode', 'own'))
      await picking
    })
    await expect(picking).resolves.toBe(true)
    expect(result.current.optionSnapshot.find((row) => row.id === 'model')?.settable).toBe(true)
    unmount()
  })

  it('shows at once and stays pickable while the write waits behind a start', async () => {
    optionsAnswering('ask', 'auto')
    const first = Promise.withResolvers<AgentSessionMutationResult<AgentSessionOptionResult>>()
    const second = Promise.withResolvers<AgentSessionMutationResult<AgentSessionOptionResult>>()
    mocks.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))

    await act(async () => {
      void result.current.setStructuredOption('permissionMode', 'full-access')
    })
    expect(permission(result.current.optionSnapshot)).toBe('full-access')
    await act(async () => {
      void result.current.setStructuredOption('permissionMode', 'auto')
    })
    expect(permission(result.current.optionSnapshot)).toBe('auto')
    expect(mocks.write).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(acceptedReply('permissionMode', 'auto')))
    await act(async () => first.resolve(acceptedReply('permissionMode', 'full-access')))
    expect(permission(result.current.optionSnapshot)).toBe('auto')
    unmount()

    // A permission pick stays available while the model request still runs.
    let model = 'model-a'
    forgetStructuredSessionSelection('session-1', LOCAL_TARGET)
    mocks.call.mockImplementation((_target: unknown, method: string, params: unknown) =>
      method === 'agentSession.setOption'
        ? mocks.write(params)
        : Promise.resolve(
            method === 'agentSession.options'
              ? {
                  models: ['model-a', 'model-b'].map((id) => ({
                    id,
                    label: id,
                    isDefault: false,
                    efforts: [],
                    supportsAutoMode: true
                  })),
                  current: { model, permissionMode: model === 'model-a' ? 'ask' : 'full-access' }
                }
              : { origin: 'unknown' }
          )
    )
    const modelWrite = Promise.withResolvers<AgentSessionMutationResult<AgentSessionOptionResult>>()
    const modeWrite = Promise.withResolvers<AgentSessionMutationResult<AgentSessionOptionResult>>()
    mocks.write
      .mockReturnValueOnce(modelWrite.promise)
      .mockReturnValueOnce(modeWrite.promise)
      .mockResolvedValue(acceptedReply('permissionMode', 'auto'))
    const claude = renderReopened(1, 'claude')
    await waitFor(() => expect(permission(claude.result.current.optionSnapshot)).toBe('ask'))
    const choices = (snapshot: readonly SessionOptionDescriptor[]) => {
      const kind = snapshot.find((row) => row.id === 'permissionMode')?.kind
      return kind?.type === 'select' ? kind.choices.map((choice) => choice.value) : []
    }
    expect(choices(claude.result.current.optionSnapshot)).toContain('auto')
    const captured = claude.result.current.setStructuredOption
    await act(async () => {
      void captured('model', 'model-b')
    })
    await act(async () => {
      void captured('permissionMode', 'full-access')
    })
    expect(permission(claude.result.current.optionSnapshot)).toBe('full-access')
    expect(choices(claude.result.current.optionSnapshot)).toContain('auto')
    await act(async () => {
      expect(await captured('permissionMode', 'auto')).toBe(true)
    })
    await act(async () => {
      const returned = await claude.result.current.optionSurface.setOption('permissionMode', 'auto')
      expect(choices(returned.snapshot)).toContain('auto')
    })
    expect(mocks.write).toHaveBeenCalledTimes(6)
    model = 'model-b'
    await act(async () => modeWrite.resolve(acceptedReply('permissionMode', 'full-access')))
    await act(async () => modelWrite.resolve(acceptedReply('model', model)))
    expect(choices(claude.result.current.optionSnapshot)).toContain('auto')
    claude.unmount()
  })

  it("shows the host's mode again when the write is refused", async () => {
    optionsAnswering('ask')
    mocks.write.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'Refused' }
    })
    const { result, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))

    await act(async () => {
      await result.current.setStructuredOption('permissionMode', 'full-access')
    })
    await waitFor(() => expect(optionReads()).toBe(2))
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('ask'))
    unmount()
  })
})
