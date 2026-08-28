// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusFactStreamMessage } from '../../../shared/agent-status-fact-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

const mocks = vi.hoisted(() => ({
  supportsCapability: vi.fn(),
  getRevision: vi.fn(),
  observe: vi.fn(),
  forget: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: mocks.getRevision
}))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observe,
  forgetAgentHookCompletionNotificationCoordinator: mocks.forget
}))

import {
  resetRemoteAgentStatusFactCursorsForTests,
  subscribeRemoteAgentStatusFacts
} from './remote-agent-status-facts'

type Callback = (response: RuntimeRpcResponse<unknown>) => void

const subscribe = vi.fn()
let onResponse: Callback

function send(message: AgentStatusFactStreamMessage): void {
  onResponse({ id: 'fact', ok: true, result: message, _meta: { runtimeId: 'runtime-a' } })
}

describe('remote agent status facts', () => {
  beforeEach(() => {
    resetRemoteAgentStatusFactCursorsForTests()
    mocks.supportsCapability.mockReset().mockResolvedValue(true)
    mocks.getRevision.mockReset().mockReturnValue(7)
    mocks.observe.mockReset()
    mocks.forget.mockReset()
    subscribe.mockReset().mockImplementation(async (_request, callbacks) => {
      onResponse = callbacks.onResponse
      return { unsubscribe: vi.fn() }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { subscribe } }
    })
  })

  it('seeds a cold cursor silently and dispatches each newer fact once', async () => {
    await subscribeRemoteAgentStatusFacts('env-a', 7, vi.fn(), ['agent-status.fact-stream.v1'])
    send({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1', headSeq: 12, gap: false })
    send({
      type: 'fact',
      fact: {
        epoch: 'epoch-1',
        seq: 13,
        paneKey: 'tab::leaf',
        worktreeId: 'wt-1',
        status: {
          state: 'done',
          prompt: '',
          updatedAt: 20,
          stateStartedAt: 20,
          stateHistory: [],
          paneKey: 'tab::leaf'
        }
      }
    })
    send({
      type: 'fact',
      fact: {
        epoch: 'epoch-1',
        seq: 13,
        paneKey: 'tab::leaf',
        worktreeId: 'wt-1',
        status: {
          state: 'done',
          prompt: '',
          updatedAt: 20,
          stateStartedAt: 20,
          stateHistory: [],
          paneKey: 'tab::leaf'
        }
      }
    })

    expect(mocks.observe).toHaveBeenCalledOnce()
  })

  it('seeds a gap and disposes a pane on its tombstone', async () => {
    await subscribeRemoteAgentStatusFacts('env-a', 7, vi.fn(), ['agent-status.fact-stream.v1'])
    send({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-2', headSeq: 40, gap: true })
    send({
      type: 'fact',
      fact: { epoch: 'epoch-2', seq: 41, paneKey: 'tab::leaf', worktreeId: 'wt-1', status: null }
    })

    expect(mocks.observe).not.toHaveBeenCalled()
    expect(mocks.forget).toHaveBeenCalledWith('tab::leaf')
  })

  it('does not subscribe when the host does not advertise the capability', async () => {
    const result = await subscribeRemoteAgentStatusFacts('env-a', 7, vi.fn(), [])
    expect(result).toBeNull()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
