// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionDefaultFixture } from '../../../../shared/agent-session-permission-default.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import type { SessionPermissionPublication } from '../../../../shared/agent-session-permission-reducer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
import { SetOptionParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

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
const target = { kind: 'environment', environmentId: 'permission-host' } as const
let fixture: PermissionDefaultFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionDefaultFixture>(
    '../../../../main/native-chat/agent-session-wire/structured-permission-default.test-fixture'
  )
}, 60_000)

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'retains desktop %s saved %s through reads, publications and reconnect',
  async (agent, initial) => {
    const host = await fixture.permissionDefaultHost(agent, initial)
    const other = initial === 'ask' ? 'bypass' : 'ask'
    const replies: ((result: unknown) => void)[] = []
    mocks.call.mockImplementation(async (_target: unknown, method: string, params: unknown) => {
      if (method === 'agentSession.options') {
        return new Promise((resolve) => replies.push(resolve))
      }
      if (method === 'agentSession.setOption') {
        const picked = SetOptionParams.parse(params)
        return host.pick(picked.value, picked.envelope)
      }
      if (method === 'agentSession.modelCatalog') {
        return { origin: 'unknown' }
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
    let transcript = EMPTY_STRUCTURED_AGENT_SESSION
    const reduce = (event: AgentSessionSubscribeEvent) => {
      transcript = reduceStructuredAgentSession(transcript, { type: 'event', event })
      return transcript.permissionPublication
    }
    const props: {
      publication?: SessionPermissionPublication
      connected: boolean
      turnId: string | null
    } = {
      publication: reduce(host.frames[0]),
      connected: true,
      turnId: null
    }
    const { result, rerender, unmount } = renderHook(
      (input: typeof props) => {
        const stateRef = useRef({ fence: 7 })
        const { mutate } = useStructuredAgentSessionMutate({
          sessionId: host.sessionId,
          target,
          stateRef
        })
        return useStructuredAgentSessionOptions({
          agent,
          sessionId: host.sessionId,
          target,
          transportEnabled: input.connected,
          isVisible: true,
          providerVisible: input.connected,
          fence: 7,
          turnId: input.turnId,
          permissionPublication: input.publication,
          unloadedTurnRevisions: undefined,
          mutate
        })
      },
      { initialProps: props }
    )
    const show = () => result.current.optionSurface.permissionPicker?.current
    const publish = (event: AgentSessionSubscribeEvent | undefined) => {
      if (!event) {
        throw new Error('No frame')
      }
      rerender({ ...props, publication: reduce(event) })
    }
    try {
      const before = await host.storedIntent()
      const oldOptions = await host.readOptions()
      expect(show()).toBe(initial)
      expect(replies.length).toBeGreaterThan(0)
      host.changeDefault(other)
      await host.publish()
      expect(host.frames).toHaveLength(1)
      await host.publish()
      expect(host.frames).toHaveLength(1)
      expect(host.fact()).toEqual({ mode: initial, fence: 7, revision: 0 })
      publish(host.frames.at(-1))
      expect(show()).toBe(initial)
      await act(async () => replies.splice(0).forEach((reply) => reply(oldOptions)))
      expect(show()).toBe(initial)
      publish(host.frames[0])
      expect(show()).toBe(initial)
      const oldOptionsAfterDefault = await host.readOptions()
      host.changeDefault(initial)
      rerender({ ...props, publication: transcript.permissionPublication, turnId: 'refresh' })
      expect(replies.length).toBeGreaterThan(0)
      const latestOptions = await host.readOptions()
      await act(async () => replies.splice(0).forEach((reply) => reply(latestOptions)))
      expect(show()).toBe(initial)
      expect(await host.storedIntent()).toEqual(before)
      expect(host.fact()).toEqual({ mode: initial, fence: 7, revision: 0 })
      rerender({ ...props, publication: transcript.permissionPublication, connected: false })
      await host.restart()
      rerender({ ...props, publication: reduce(await host.snapshot()) })
      expect(show()).toBe(initial)
      const lateReplies = replies.splice(0)
      expect(lateReplies.length).toBeGreaterThan(0)
      host.permitWrites()
      await act(async () =>
        expect(await result.current.optionSurface.permissionPicker?.setMode(other)).toBe(true)
      )
      expect(host.fact()).toEqual({ mode: other, fence: 7, revision: 1 })
      expect(show()).toBe(other)
      await act(async () => lateReplies.forEach((reply) => reply(latestOptions)))
      expect(show()).toBe(other)
      host.changeDefault(initial)
      publish(host.frames[0])
      rerender({ ...props, publication: transcript.permissionPublication, turnId: 'explicit' })
      await act(async () => replies.splice(0).forEach((reply) => reply(oldOptionsAfterDefault)))
      expect(show()).toBe(other)
      await host.restart()
      publish(await host.snapshot())
      expect(show()).toBe(other)
      expect((await host.readOptions()).permissionModes).toMatchObject({
        current: other,
        revision: 1
      })
    } finally {
      unmount()
      await host.close()
    }
  }
)
