// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  renderOptions,
  REOPENED,
  currentValue
} from './use-structured-agent-session-options.test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session/agent-session-wire'
import type * as RuntimeRpc from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionOptionStamp } from './structured-agent-session-status-hooks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpc>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))

it.each([2, 20])('isolates mode refresh reads and renders with %s mounted chats', async (count) => {
  resetStructuredAgentSessionStatusFeedsForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 1 }])
  forgetStructuredSessionSelection('session-1')
  for (let i = 0; i < count - 1; i++) {
    forgetStructuredSessionSelection(`other-${i}`)
  }
  const emitters = new Map<string, (event: AgentSessionStatusEvent) => void>()
  mocks.subscribeStatus.mockImplementation(async (target, onEvent) => {
    emitters.set(target.kind, onEvent)
    return { unsubscribe: () => {} }
  })
  let localMode: 'default' | 'plan' = 'default'
  let remoteMode: 'default' | 'plan' = 'default'
  const read = vi.fn(async (target: RuntimeClientTarget) => ({
    models: [],
    current: {
      interactionMode: target.kind === 'local' ? localMode : remoteMode,
      acceptedInputSources: { interactionMode: 'saved' }
    }
  }))
  answer({ options: read })
  const { mutate } = mutateWith(async () => null)
  const stampRenders = vi.fn()
  const stamp = renderHook(() => {
    stampRenders()
    return useStructuredAgentSessionOptionStamp('session-1', { kind: 'local' })
  })
  const affectedRenders = vi.fn()
  const unaffectedRenders = vi.fn()
  const remoteRenders = vi.fn()
  const first = renderOptions({ ...REOPENED, onRender: affectedRenders }, mutate)
  const sameChat = renderOptions({ ...REOPENED, onRender: affectedRenders }, mutate)
  const others = Array.from({ length: count - 1 }, (_, i) =>
    renderOptions({ ...REOPENED, sessionId: `other-${i}`, onRender: unaffectedRenders }, mutate)
  )
  const remote = renderOptions({ ...REOPENED, paired: true, onRender: remoteRenders }, mutate)
  const mounted = [first, sameChat, ...others, remote]
  const summary = {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agent: 'codex',
    status: 'idle' as const,
    latestPrompt: '',
    updatedAt: 1
  }
  const publish = (host: string, session = summary, mode: 'default' | 'plan' = 'default') =>
    act(async () =>
      emitters.get(host)?.({ type: 'status', session: { ...session, interactionMode: mode } })
    )
  try {
    for (const hook of mounted) {
      await waitFor(() =>
        expect(currentValue(hook.result.current.optionSnapshot, 'interactionMode')).toBe('default')
      )
    }
    await publish('local')
    await publish('environment')
    for (let i = 0; i < count - 1; i++) {
      await publish('local', { ...summary, sessionId: `other-${i}` })
    }
    await act(async () => {})
    read.mockClear()
    stampRenders.mockClear()
    affectedRenders.mockClear()
    unaffectedRenders.mockClear()
    remoteRenders.mockClear()
    await publish('local', { ...summary, sessionId: 'unmounted' }, 'plan')
    await publish('local', { ...summary, latestPrompt: 'transcript changed' })
    expect(read).not.toHaveBeenCalled()
    expect(stampRenders).not.toHaveBeenCalled()
    expect(unaffectedRenders).not.toHaveBeenCalled()
    expect(remoteRenders).not.toHaveBeenCalled()

    localMode = 'plan'
    await publish('local', summary, 'plan')
    for (const hook of [first, sameChat]) {
      await waitFor(() =>
        expect(currentValue(hook.result.current.optionSnapshot, 'interactionMode')).toBe('plan')
      )
    }
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect(read.mock.calls.length).toBeLessThanOrEqual(2)
    expect(affectedRenders).toHaveBeenCalled()
    expect(stampRenders).toHaveBeenCalled()
    expect(unaffectedRenders).not.toHaveBeenCalled()
    expect(remoteRenders).not.toHaveBeenCalled()

    read.mockClear()
    stampRenders.mockClear()
    affectedRenders.mockClear()
    remoteMode = 'plan'
    await publish('environment', summary, 'plan')
    await waitFor(() =>
      expect(currentValue(remote.result.current.optionSnapshot, 'interactionMode')).toBe('plan')
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(remoteRenders).toHaveBeenCalled()
    expect(affectedRenders).not.toHaveBeenCalled()
    expect(stampRenders).not.toHaveBeenCalled()
    expect(unaffectedRenders).not.toHaveBeenCalled()
  } finally {
    stamp.unmount()
    mounted.forEach((hook) => hook.unmount())
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockImplementation(async () => ({ unsubscribe: vi.fn() }))
  }
})
