// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostOwner from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'

// Every History row, chat header, pane button and menu mounts these hooks. A status or switch
// change elsewhere may re-read each one once, never re-render a consumer whose answer is unchanged.

const lookups = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/runtime/structured-agent-session-owner', async (load) => {
  const actual = await load<typeof HostOwner>()
  return {
    ...actual,
    structuredAgentSessionTargetForHost: (
      ...args: Parameters<typeof actual.structuredAgentSessionTargetForHost>
    ) => {
      lookups.count += 1
      return actual.structuredAgentSessionTargetForHost(...args)
    }
  }
})
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => [],
  readLocalRuntimeCapabilitiesOrUnknown: () => [],
  subscribeLocalRuntimeCapabilityObservation: () => () => {}
}))

const { useInPlaceSwitchCapability } = await import('./in-place-switch-support')
const { useConversationSwitchPending } = await import('./conversation-switch-state')
const { conversationSwitchChanged, pendingNativeChatCliSwitches } =
  await import('./pending-conversation-surface-switches')

afterEach(() => {
  cleanup()
  pendingNativeChatCliSwitches.clear()
})

function environment(id: string) {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: id
  }
}

function work(consumers: number): { reads: number; renders: number } {
  useAppStore.getState().setRuntimeEnvironments([environment('host-a')])
  let renders = 0
  for (let index = 0; index < consumers; index++) {
    renderHook(() => {
      renders += 1
      return [
        useInPlaceSwitchCapability('runtime:host-a', 'codex'),
        useConversationSwitchPending({
          direction: 'chat',
          executionHostId: 'runtime:host-a',
          workspaceId: 'wt-1',
          agent: 'codex',
          sessionId: `chat-${index}`
        })
      ]
    })
  }
  renders = 0
  lookups.count = 0
  act(() => {
    // Unrelated to the hooks: no subscriber runs.
    useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    // Another host's status and another conversation's switch: each consumer re-reads, none renders.
    useAppStore.getState().setRuntimeEnvironments([environment('host-a'), environment('host-b')])
    useAppStore.getState().setRuntimeEnvironments([environment('host-a')])
    pendingNativeChatCliSwitches.set('runtime:host-b\0other-chat', {
      chatTabId: null,
      workspaceId: 'wt-2',
      executionHostId: 'runtime:host-b'
    })
    conversationSwitchChanged()
  })
  cleanup()
  return { reads: lookups.count, renders }
}

it('re-reads each mounted switch consumer a fixed number of times and renders none', () => {
  const small = work(20)
  const large = work(200)
  expect(small.reads).toBeGreaterThan(0)
  expect(small.renders).toBe(0)
  expect(large.renders).toBe(0)
  // Two status changes, two reads each at most (the hook and React's tearing check).
  expect(small.reads).toBeLessThanOrEqual(20 * 4)
  expect(large.reads).toBeLessThanOrEqual(10 * small.reads)
})
