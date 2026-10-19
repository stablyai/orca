// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const mutate: StructuredAgentSessionMutate = vi.fn(async () => null)
const LOCAL_TARGET = { kind: 'local' } as const

function optionsAnswering(...modes: (string | undefined)[]): void {
  let read = 0
  mocks.call.mockImplementation((_target: unknown, method: string) => {
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

function renderReopened(fence: number) {
  return renderHook(
    (props: { fence: number; stamp: string }) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
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

  // A restart for a new mode moves the fence; the pill never blanks before the next read answers.
  it('keeps the mode across a fence of the same chat', async () => {
    optionsAnswering('auto')
    const { result, rerender, unmount } = renderReopened(1)
    await waitFor(() => expect(permission(result.current.optionSnapshot)).toBe('auto'))

    mocks.call.mockImplementation(() => new Promise(() => {}))
    rerender({ fence: 2, stamp: 'model-a|ask' })
    expect(permission(result.current.optionSnapshot)).toBe('auto')
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
    mocks.call.mockReset()
    vi.mocked(mutate).mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('shows at once and stays pickable while the write waits behind a start', async () => {
    optionsAnswering('ask', 'auto')
    const first = Promise.withResolvers<{ options: Record<string, string> }>()
    const second = Promise.withResolvers<{ options: Record<string, string> }>()
    vi.mocked(mutate).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
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
    expect(vi.mocked(mutate)).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ options: { permissionMode: 'auto' } }))
    await act(async () => first.resolve({ options: { permissionMode: 'full-access' } }))
    expect(permission(result.current.optionSnapshot)).toBe('auto')
    unmount()
  })

  it("shows the host's mode again when the write is refused", async () => {
    optionsAnswering('ask')
    vi.mocked(mutate).mockResolvedValue(null)
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
