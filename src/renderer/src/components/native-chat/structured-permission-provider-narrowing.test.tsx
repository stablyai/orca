// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PermissionNarrowingFixture } from '../../../../shared/agent-session-permission-narrowing.test-fixture'
import type { AgentSessionPermissionSeed } from '../../../../shared/agent-chat-permission-mode'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
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

it.each(['codex-start', 'claude-start', 'claude-model'] as const)(
  'shows durable Ask on desktop after %s narrows Auto through the production host',
  async (scenario) => {
    const { permissionNarrowingHost } = await vi.importActual<PermissionNarrowingFixture>(
      '../../../../main/native-chat/agent-session-wire/structured-permission-narrowing.test-fixture'
    )
    const host = await permissionNarrowingHost(scenario)
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
      (publication: AgentSessionPermissionSeed) => {
        const stateRef = useRef({ fence: publication.fence })
        stateRef.current.fence = publication.fence
        const { mutate } = useStructuredAgentSessionMutate({
          sessionId: host.sessionId,
          target,
          stateRef
        })
        return useStructuredAgentSessionOptions({
          agent: host.agent,
          sessionId: host.sessionId,
          target,
          transportEnabled: true,
          isVisible: true,
          providerVisible: false,
          fence: publication.fence,
          turnId: null,
          permissionPublication: publication,
          unloadedTurnRevisions: undefined,
          mutate
        })
      },
      { initialProps: host.fact() }
    )
    try {
      expect(result.current.optionSurface.permissionPicker?.current).toBe('auto')
      await host.start()
      if (scenario === 'claude-model') {
        expect(host.fact()).toMatchObject({ mode: 'auto', revision: 9 })
        await host.switchModel()
      }
      const narrowed = host.fact()
      expect(narrowed).toEqual({ mode: 'ask', fence: 8, revision: 10 })
      expect(await host.storedIntent()).toMatchObject({
        options: { permissionMode: 'ask' },
        permissionRevision: 10
      })
      let transcript = EMPTY_STRUCTURED_AGENT_SESSION
      for (const event of host.frames) {
        transcript = reduceStructuredAgentSession(transcript, { type: 'event', event })
      }
      expect(transcript.permissionPublication).toEqual(narrowed)
      rerender(narrowed)
      const options = await host.readOptions()
      expect(options.permissionModes).toMatchObject({ current: 'ask', fence: 8, revision: 10 })
      await act(async () => replies.forEach((reply) => reply(options)))
      expect(result.current.optionSurface.permissionPicker).toMatchObject({
        current: 'ask',
        pending: false
      })
      rerender({ mode: 'auto', fence: 8, revision: 9 })
      expect(result.current.optionSurface.permissionPicker?.current).toBe('ask')
    } finally {
      unmount()
      await host.close()
    }
  }
)
