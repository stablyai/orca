// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import {
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session-permission-modes-capability'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'

const mocks = vi.hoisted(() => {
  const summary: { current: Record<string, unknown> | null } = { current: null }
  return { call: vi.fn(), summary, listeners: new Set<() => void>() }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

vi.mock('./StructuredAgentSessionStatusBridge', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  }
  return {
    ...(await importOriginal<object>()),
    useStructuredAgentSessionStatusSummary: () => ({
      summary: useSyncExternalStore(subscribe, () => mocks.summary.current),
      observation: 'live' as const
    })
  }
})

import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL_TARGET = { kind: 'local' } as const
const mutate: StructuredAgentSessionMutate = vi.fn(async () => null)

function report(mode: string | null): void {
  mocks.summary.current = {
    sessionId: 'session-1',
    runtimePermission: { fence: 1, mode }
  }
  for (const listener of mocks.listeners) {
    listener()
  }
}

function agentGone(): void {
  mocks.summary.current = { sessionId: 'session-1', runtimePermission: null }
  for (const listener of mocks.listeners) {
    listener()
  }
}

function permission(snapshot: readonly SessionOptionDescriptor[]) {
  const entry = snapshot.find((descriptor) => descriptor.id === 'permissionMode')
  return entry?.kind.type === 'select'
    ? { mode: entry.kind.currentValue, settable: entry.settable }
    : null
}

function renderLiveClaudeChat() {
  return renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'claude',
      sessionId: 'session-1',
      target: LOCAL_TARGET,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      fence: 1,
      turnId: null,
      unloadedTurnRevisions: undefined,
      hostOptionStamp: 'model-a|ask',
      mutate
    })
  )
}

describe('a permission pick while the agent from the last turn is still running', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
      AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
    ])
    resetHostModelCatalogSnapshotsForTests()
    mocks.call.mockReset()
    let permissionMode = 'ask'
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.options'
        ? Promise.resolve({
            models: [{ id: 'model-a', label: 'Model A', isDefault: true, efforts: [] }],
            current: { model: 'model-a', permissionMode, reportedPermissionMode: 'ask' }
          })
        : new Promise(() => {})
    )
    vi.mocked(mutate).mockReset()
    vi.mocked(mutate).mockImplementation(async (_method, _op, params) => {
      permissionMode = params && 'value' in params ? String(params.value) : permissionMode
      return { key: 'permissionMode', value: permissionMode, options: { permissionMode } }
    })
    report('ask')
  })

  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it('shows the pick until the agent reports again, then shows that report', async () => {
    const { result, unmount } = renderLiveClaudeChat()
    await waitFor(() =>
      expect(permission(result.current.optionSnapshot)).toEqual({ mode: 'ask', settable: true })
    )

    await act(async () => {
      expect(await result.current.setStructuredOption('permissionMode', 'full-access')).toBe(true)
    })
    // The host republishes the old agent's unchanged report after saving the pick.
    act(() => report('ask'))
    await waitFor(() => expect(mocks.call.mock.calls.length).toBeGreaterThan(1))
    expect(permission(result.current.optionSnapshot)).toEqual({
      mode: 'full-access',
      settable: true
    })

    // The next message replaces the agent; its report is what runs from then on.
    act(() => agentGone())
    act(() => report('accept-edits'))
    expect(permission(result.current.optionSnapshot)?.mode).toBe('accept-edits')
    act(() => report('ask'))
    expect(permission(result.current.optionSnapshot)?.mode).toBe('ask')
    unmount()
  })

  it("shows the agent's report again when the write is refused", async () => {
    vi.mocked(mutate).mockResolvedValue(null)
    const { result, unmount } = renderLiveClaudeChat()
    await waitFor(() => expect(permission(result.current.optionSnapshot)?.mode).toBe('ask'))

    await act(async () => {
      expect(await result.current.setStructuredOption('permissionMode', 'full-access')).toBe(false)
    })
    expect(permission(result.current.optionSnapshot)?.mode).toBe('ask')
    unmount()
  })
})
