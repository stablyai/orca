// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { PermissionRestartFixture } from '../../../../shared/agent-session-permission-restart.test-fixture'
import type { AgentSessionPermissionSeed } from '../../../../shared/agent-chat-permission-mode'
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
beforeEach(() => {
  mocks.call.mockReset()
})
const target = { kind: 'environment', environmentId: 'permission-host' } as const

it.each(['claude', 'codex'] as const)(
  'keeps successful %s permission picks after reopening the real store with the client mounted',
  async (agent) => {
    const { permissionRestartHost } = await vi.importActual<PermissionRestartFixture>(
      '../../../../main/native-chat/agent-session-wire/structured-permission-restart.test-fixture'
    )
    for (const retained of ['ask', 'bypass'] as const) {
      const host = await permissionRestartHost(agent, retained)
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
      const prior = host.fact()
      const { result, rerender, unmount } = renderHook(
        (publication: AgentSessionPermissionSeed) => {
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
            transportEnabled: true,
            isVisible: true,
            providerVisible: false,
            fence: 7,
            turnId: null,
            permissionPublication: publication,
            unloadedTurnRevisions: undefined,
            mutate
          })
        },
        { initialProps: prior }
      )
      try {
        expect(result.current.optionSurface.permissionPicker?.current).toBe(retained)
        await host.restart()
        expect(host.fact()).toEqual(prior)
        rerender(host.fact())
        const requested = retained === 'ask' ? 'bypass' : 'ask'
        await act(async () => {
          expect(await result.current.optionSurface.permissionPicker?.setMode(requested)).toBe(true)
        })
        const accepted = host.fact()
        expect(accepted).toEqual({ mode: requested, fence: 7, revision: prior.revision + 1 })
        expect(result.current.optionSurface.permissionPicker).toMatchObject({
          current: requested,
          pending: false
        })
        rerender(accepted)
        const options = await host.readOptions()
        await act(async () => replies.forEach((reply) => reply(options)))
        expect(result.current.optionSurface.permissionPicker?.current).toBe(requested)
        rerender(prior)
        expect(result.current.optionSurface.permissionPicker?.current).toBe(requested)
      } finally {
        unmount()
        await host.close()
      }
    }
  }
)
