// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionAcquisitionFixture } from '../../../../shared/agent-session-permission-acquisition.test-fixture'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  getStructuredLaunchStateBySessionId: () => undefined,
  notifyStructuredLaunchListeners: () => {},
  subscribeStructuredAgentLaunchStatus: () => () => {}
}))
let fixture: PermissionAcquisitionFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionAcquisitionFixture>(
    '../../../../main/native-chat/agent-session-wire/structured-permission-acquisition.test-fixture'
  )
}, 60_000)

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'keeps desktop %s labels on acquired %s after the default changes',
  async (agent, initial) => {
    const host = await fixture.permissionAcquisitionHost(agent, initial)
    const before = await host.readOptions()
    await host.start()
    // Claude withholds its initialize answer, so the default changes under a still-starting child.
    expect(host.childPhase()).toBe(agent === 'claude' ? 'starting' : 'ready')
    expect(await host.storedIntent()).toMatchObject({
      options: { permissionMode: initial },
      permissionRevision: 0
    })
    host.updateSettings({ nativeChatPermissionMode: initial === 'ask' ? 'bypass' : 'ask' })
    const event = await host.snapshot()
    const transcript = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event
    })
    const replies: ((result: unknown) => void)[] = []
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.options') {
        return new Promise((resolve) => replies.push(resolve))
      }
      if (method === 'agentSession.modelCatalog') {
        return { origin: 'unknown' }
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
    const { result, rerender, unmount } = renderHook(
      (publication) =>
        useStructuredAgentSessionOptions({
          agent,
          sessionId: host.sessionId,
          target: { kind: 'environment', environmentId: 'permission-host' },
          transportEnabled: true,
          isVisible: true,
          providerVisible: false,
          fence: event.fence,
          turnId: null,
          permissionPublication: publication,
          unloadedTurnRevisions: undefined,
          mutate: async () => {
            throw new Error('No permission picks in this scenario')
          }
        }),
      { initialProps: transcript.permissionPublication }
    )
    try {
      expect(host.fact()).toEqual({ mode: initial, fence: 8, revision: 0 })
      expect(result.current.optionSurface.permissionPicker?.current).toBe(initial)
      await act(async () => replies.splice(0).forEach((reply) => reply(before)))
      expect(result.current.optionSurface.permissionPicker?.current).toBe(initial)
      rerender({
        mode: initial === 'ask' ? 'bypass' : 'ask',
        fence: 8,
        revision: 0
      })
      expect(result.current.optionSurface.permissionPicker?.current).toBe(initial)
      host.answerInitialize()
      await host.send()
      await vi.waitFor(() => expect(host.delivered()).toBe(1))
      expect(host.launchMode()).toBe(initial)
      expect(host.controls()).toEqual([])
      expect((await host.readOptions()).permissionModes).toMatchObject({
        current: initial,
        revision: 0
      })
      expect(result.current.optionSurface.permissionPicker?.current).toBe(host.launchMode())
    } finally {
      unmount()
      await host.close()
    }
  }
)
