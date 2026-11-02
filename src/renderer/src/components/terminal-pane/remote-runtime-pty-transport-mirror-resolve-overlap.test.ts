import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

// Overlap pane resolution with activation to save a round trip; reread afterward if activation materializes a pending surface.

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, subscriptionSendBinary, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

function calledMethods(): string[] {
  return runtimeCall.mock.calls.map(([request]) => request.method)
}

describe('web mirror reveal: resolvePane overlaps the activation', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    resolvedPaneHandle = 'terminal-1'
  })

  async function attachMirror() {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    return transport.connect({
      url: '',
      sessionId: 'remote:env-1@@terminal-1',
      cols: 100,
      rows: 30,
      callbacks: {}
    })
  }

  it('sends resolvePane before the activation answers, and reads it once', async () => {
    const defaultCall = runtimeCall.getMockImplementation()!
    let answerActivate: () => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'session.tabs.activate') {
        return new Promise((resolve) => {
          answerActivate = () => resolve(defaultCall(request))
        })
      }
      if (request.method === 'terminal.resolvePane') {
        return Promise.resolve(defaultCall(request)).then((response) => ({
          ...response,
          result: {
            terminal: { ...response.result.terminal, incarnationId: 'incarnation-resolved' }
          }
        }))
      }
      return defaultCall(request)
    })

    const attached = attachMirror()
    await vi.waitFor(() => expect(calledMethods()).toContain('terminal.resolvePane'), {
      timeout: 10_000
    })
    // The activation has not answered, yet the pane read is already on the wire.
    expect(calledMethods()).toContain('session.tabs.activate')
    expect(subscriptionSendBinary).not.toHaveBeenCalled()

    answerActivate()
    await expect(attached).resolves.toMatchObject({
      id: 'remote:env-1@@terminal-1',
      incarnationId: 'incarnation-resolved'
    })
    expect(calledMethods().filter((method) => method === 'terminal.resolvePane')).toHaveLength(1)
  })

  it('re-reads the pane after an activation that materialized a different handle', async () => {
    const defaultCall = runtimeCall.getMockImplementation()!
    let activated = false
    let earlyReadAnswered: () => void = () => {}
    const earlyRead = new Promise<void>((resolve) => {
      earlyReadAnswered = resolve
    })
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'session.tabs.activate') {
        await earlyRead
        // The surface was pending; activating it publishes the real PTY handle.
        resolvedPaneHandle = 'terminal-2'
        activated = true
        return defaultCall(request)
      }
      if (request.method === 'terminal.resolvePane' && !activated) {
        queueMicrotask(earlyReadAnswered)
        return { ok: false, error: { code: 'runtime_error', message: 'terminal_not_found' } }
      }
      if (request.method === 'terminal.resolvePane') {
        const response = await defaultCall(request)
        return {
          ...response,
          result: {
            terminal: { ...response.result.terminal, incarnationId: 'incarnation-after-activate' }
          }
        }
      }
      return defaultCall(request)
    })

    await expect(attachMirror()).resolves.toMatchObject({
      id: 'remote:env-1@@terminal-2',
      incarnationId: 'incarnation-after-activate'
    })
    expect(calledMethods().slice(0, 3)).toEqual([
      'terminal.resolvePane',
      'session.tabs.activate',
      'terminal.resolvePane'
    ])
  })

  it('re-reads a pane answered before the activation learned its incarnation', async () => {
    const defaultCall = runtimeCall.getMockImplementation()!
    let activated = false
    let earlyReadAnswered: () => void = () => {}
    const earlyRead = new Promise<void>((resolve) => {
      earlyReadAnswered = resolve
    })
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'session.tabs.activate') {
        await earlyRead
        activated = true
        const response = await defaultCall(request)
        return {
          ...response,
          result: {
            ...response.result,
            tabs: response.result.tabs.map((tab: RuntimeMobileSessionClientTab) => ({
              ...tab,
              incarnationId: 'incarnation-learned'
            }))
          }
        }
      }
      if (request.method === 'terminal.resolvePane') {
        const response = await defaultCall(request)
        if (!activated) {
          queueMicrotask(earlyReadAnswered)
          return response
        }
        return {
          ...response,
          result: {
            terminal: { ...response.result.terminal, incarnationId: 'incarnation-learned' }
          }
        }
      }
      return defaultCall(request)
    })

    // The same handle answered early without an incarnation must not erase the learned one.
    await expect(attachMirror()).resolves.toMatchObject({
      id: 'remote:env-1@@terminal-1',
      incarnationId: 'incarnation-learned'
    })
    expect(calledMethods().filter((method) => method === 'terminal.resolvePane')).toHaveLength(2)
  })
})
