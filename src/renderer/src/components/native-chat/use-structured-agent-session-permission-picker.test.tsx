// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  enqueue: vi.fn(),
  hold: vi.fn<(sessionId: string, id: string, encoded: string) => Promise<unknown> | null>()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

type Props = {
  fence: number | null
  transportEnabled: boolean
  seed?: Record<string, string>
  held?: Record<string, string>
  permissionMode?: string
}

// Stable across renders, as a real target is: a fresh object each render re-runs every read.
const LOCAL_TARGET = { kind: 'local' } as const

const OPTIONS = {
  models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: [] }],
  current: { model: 'sonnet', confirmed: ['model'] }
}

function answerOptions(options: unknown): void {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.options' ? Promise.resolve(options) : new Promise(() => {})
  )
}

function render(initial: Props, mutate: StructuredAgentSessionMutate) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOptions({
        agent: 'claude',
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        transportEnabled: props.transportEnabled,
        isVisible: true,
        providerVisible: props.transportEnabled,
        fence: props.fence,
        turnId: null,
        permissionMode: props.permissionMode,
        unloadedTurnRevisions: undefined,
        mutate,
        launch: {
          kind: 'new',
          ...(props.seed ? { seedOptions: props.seed } : {}),
          heldOptions: props.held ?? {}
        }
      }),
    { initialProps: initial }
  )
}

function mutateReplying(options: Record<string, string>) {
  const response = {
    key: 'permissionMode',
    value: options.permissionMode ?? 'ask',
    options
  } satisfies AgentSessionOptionResult
  const calls = vi.fn().mockResolvedValue(response)
  const mutate: StructuredAgentSessionMutate = (...args) => calls(...args)
  return { mutate, calls }
}

describe('the structured chat permission picker', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
  })

  // Capability gate: the field is how a host says it offers the picker.
  it('shows no picker for a host whose options carry no permission mode', async () => {
    answerOptions(OPTIONS)
    const { result, unmount } = render(
      { transportEnabled: true, fence: 1 },
      mutateReplying({}).mutate
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.optionSurface.permissionPicker).toBeNull()
    unmount()
  })

  it('shows the host report and sends a pick through setOption, never as a launch default', async () => {
    let hostMode = 'ask'
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.options'
        ? Promise.resolve({
            ...OPTIONS,
            permissionModes: {
              current: hostMode,
              supported: ['ask', 'accept-edits', 'auto', 'bypass']
            }
          })
        : new Promise(() => {})
    )
    const { mutate: reply, calls } = mutateReplying({ model: 'sonnet', permissionMode: 'bypass' })
    const mutate: StructuredAgentSessionMutate = async (...args) => {
      hostMode = 'bypass'
      return reply(...args)
    }
    const { result, unmount } = render({ transportEnabled: true, fence: 1 }, mutate)
    await waitFor(() => expect(result.current.optionSurface.permissionPicker?.current).toBe('ask'))

    await act(async () => {
      await result.current.optionSurface.permissionPicker?.setMode('bypass')
    })

    expect(calls).toHaveBeenCalledWith(
      'agentSession.setOption',
      'agentSession.setOption',
      {
        key: 'permissionMode',
        value: 'bypass'
      },
      1
    )
    expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
    // The next chat starts where the setting points, not where this chat was moved.
    expect(mocks.enqueue).not.toHaveBeenCalled()
    unmount()
  })

  it('holds a pick made before the session exists for the launch to apply', async () => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    mocks.hold.mockReturnValue(new Promise(() => {}))
    const { result, unmount } = render(
      { transportEnabled: false, fence: null, seed: { permissionMode: 'bypass' } },
      mutateReplying({}).mutate
    )
    // The create seed carries the mode the host will create the chat in.
    expect(result.current.optionSurface.permissionPicker).toMatchObject({
      current: 'bypass',
      disabled: false
    })

    await act(async () => {
      await result.current.optionSurface.permissionPicker?.setMode('ask')
    })

    expect(mocks.hold).toHaveBeenCalledWith('session-1', 'permissionMode', 'ask')
    unmount()
  })

  it('accepts a pick while published but not yet attached', async () => {
    mocks.hold.mockReturnValue(
      Promise.resolve({ kind: 'accepted', options: { permissionMode: 'auto' } })
    )
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const { result, unmount } = render(
      { transportEnabled: true, fence: null, seed: { permissionMode: 'ask' } },
      mutateReplying({}).mutate
    )
    expect(result.current.optionSurface.permissionPicker?.disabled).toBe(false)
    await act(async () => {
      expect(await result.current.optionSurface.permissionPicker?.setMode('auto')).toBe(true)
    })
    expect(mocks.hold).toHaveBeenCalledWith('session-1', 'permissionMode', 'auto', LOCAL_TARGET)
    expect(result.current.optionSurface.permissionPicker?.current).toBe('auto')
    unmount()
  })
})

it('reconciles an idle host mode update without a local pick', async () => {
  let current = 'ask'
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.options'
      ? Promise.resolve({ ...OPTIONS, permissionModes: { current, supported: ['ask', 'bypass'] } })
      : new Promise(() => {})
  )
  const { result, rerender, unmount } = render(
    { transportEnabled: true, fence: 1, permissionMode: 'ask' },
    mutateReplying({}).mutate
  )
  await waitFor(() => expect(result.current.optionSurface.permissionPicker?.current).toBe('ask'))
  current = 'bypass'
  rerender({ transportEnabled: true, fence: 1, permissionMode: 'bypass' })
  await waitFor(() => expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass'))
  unmount()
})

it('holds provisional Auto before capability discovery', async () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  mocks.hold.mockClear()
  mocks.hold.mockReturnValue(new Promise(() => {}))
  const { result, unmount } = render(
    { transportEnabled: false, fence: null, seed: { permissionMode: 'ask' } },
    mutateReplying({}).mutate
  )
  expect(result.current.optionSurface.permissionPicker?.supported).toContain('auto')
  await act(async () => {
    expect(await result.current.setStructuredOption('permissionMode', 'auto')).toBe(true)
  })
  expect(mocks.hold).toHaveBeenCalledWith('session-1', 'permissionMode', 'auto')
  unmount()
})

it('keeps a newer host mode when an older post-pick refresh answers last', async () => {
  const report = (current: string) => ({
    ...OPTIONS,
    permissionModes: { current, supported: ['ask', 'bypass'] }
  })
  let hostMode = 'ask'
  let answerHeld: (value: unknown) => void = () => {}
  let holdNext = false
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method !== 'agentSession.options') {
      return new Promise(() => {})
    }
    if (holdNext) {
      holdNext = false
      return new Promise((resolve) => {
        answerHeld = resolve
      })
    }
    return Promise.resolve(report(hostMode))
  })
  const { mutate: reply } = mutateReplying({ permissionMode: 'ask' })
  const mutate: StructuredAgentSessionMutate = async (...args) => {
    holdNext = true
    return reply(...args)
  }
  const { result, rerender, unmount } = render(
    { transportEnabled: true, fence: 1, permissionMode: 'ask' },
    mutate
  )
  await waitFor(() => expect(result.current.optionSurface.permissionPicker?.current).toBe('ask'))
  // An explicit Ask pick starts a post-write refresh that stays unanswered.
  await act(async () => {
    await result.current.optionSurface.permissionPicker?.setMode('ask')
  })
  // Another client moves the chat to Full access; the publication's read answers first.
  hostMode = 'bypass'
  rerender({ transportEnabled: true, fence: 1, permissionMode: 'bypass' })
  await waitFor(() => expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass'))
  await act(async () => {
    answerHeld(report('ask'))
  })
  rerender({ transportEnabled: true, fence: 1, permissionMode: 'bypass' })
  expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
  unmount()
})
