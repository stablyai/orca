import { afterEach, expect, it, vi } from 'vitest'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import { createNativeChatCurrentRequestsBinding } from '../../../shared/native-chat-current-requests-binding'
import type { AgentSessionCurrentRequestsMarker } from '../../../shared/agent-session-current-requests-wire'
import {
  currentMessageQuestionView,
  type AgentSessionCurrentRequestsState
} from '../../../shared/agent-session-current-requests'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const cleanup: (() => void)[] = []
afterEach(async () => {
  cleanup.splice(0, cleanup.length, ...cleanup.toReversed())
  cleanup.forEach((release) => release())
  cleanup.length = 0
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('./web-runtime-client')
})

it.each(
  [10, 100].flatMap((count) =>
    ['before-connect', 'after-dispatch'].map((phase) => ({ count, phase }))
  )
)(
  'drains actual browser queue and registry for $count retired views $phase',
  async ({ count, phase }) => {
    vi.resetModules()
    vi.useFakeTimers()
    const globals = installBrowserGlobals()
    Object.assign(globals.window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    writeStoredRuntimeEnvironment(globals.storage, 'host-a')
    let serial = 0
    let unblock = () => {}
    let connecting = phase === 'before-connect'
    let connection = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const sends: { id: string; params: unknown }[] = []
    const registry = new WebRuntimeRequestRegistry({
      deviceToken: 'fixture',
      nextId: () => `rpc-${++serial}`,
      waitForConnected: () => (connecting ? connection : Promise.resolve()),
      sendEncrypted: (message) => {
        if (
          !message ||
          typeof message !== 'object' ||
          !('id' in message) ||
          typeof message.id !== 'string' ||
          !('params' in message)
        ) {
          throw new Error('Expected request envelope')
        }
        sends.push({ id: message.id, params: message.params })
        return true
      }
    })
    registry.connectionOpened()
    const call = vi.fn(registry.call.bind(registry))
    let active = 0
    let settled = 0
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        connectionEpoch = registry.connectionEpoch
        call(...args: Parameters<typeof registry.call>) {
          active++
          return call(...args).finally(() => {
            active--
            settled++
          })
        }
        close() {
          registry.rejectAll('fixture closed')
        }
      }
    }))
    cleanup.push(() => registry.rejectAll('fixture cleanup'))
    const { createWebNativeChatApi } = await import('./preload-api/web-native-chat-api')
    const { webRuntimeState } = await import('./preload-api/web-runtime-session')
    const api = createWebNativeChatApi({ environment: webRuntimeState.activeEnvironment })
    const marker = (revision: number, sessionId = 'target'): AgentSessionCurrentRequestsMarker => ({
      contract: 'agent-session.current-requests.v2',
      sessionId,
      epoch: 'epoch',
      publisher: 'publisher',
      revision,
      owner: sessionId,
      version: `${sessionId}-${revision}`
    })
    const states = new Map<string, AgentSessionCurrentRequestsState>()
    const binding = (name: string) => {
      const owner = createNativeChatCurrentRequestsBinding({
        read: (request, signal) => api.currentRequests({ ...request, agent: 'codex' }, signal),
        publish: (state) => states.set(name, state)
      })
      cleanup.push(owner.invalidate)
      return owner
    }
    const flush = () => vi.advanceTimersByTimeAsync(0)
    const respond = (id: string, current: AgentSessionCurrentRequestsMarker) => {
      const pending = registry.pending.get(id)
      if (!pending) {
        throw new Error('Expected actual registry entry')
      }
      registry.pending.delete(id)
      clearTimeout(pending.timeout)
      pending.resolve({
        id,
        ok: true,
        _meta: { runtimeId: 'registry-runtime' },
        result: {
          marker: current,
          json: JSON.stringify({
            blocking: [],
            asyncQuestions: [],
            context: { sessionId: current.sessionId, boundary: 'root' }
          }),
          nextCursor: null
        }
      })
    }
    const owner = binding('target')
    owner.observe({ type: 'appended', currentRequests: marker(1) })
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    expect(registry.pending.size).toBe(phase === 'before-connect' ? 0 : 1)
    for (let revision = 2; revision <= count + 1; revision++) {
      owner.observe({ type: 'appended', currentRequests: marker(revision) })
    }
    // Supersession requests abort, but cannot free a still-unsettled real connect operation.
    if (phase === 'before-connect') {
      expect(call).toHaveBeenCalledTimes(1)
      expect(sends).toHaveLength(0)
      expect(active).toBe(1)
      connecting = false
      unblock()
    }
    await flush()
    expect(registry.pending.size).toBe(1)
    expect(call).toHaveBeenCalledTimes(2)
    const currentSend = sends.at(-1)!
    expect(currentSend.params).toMatchObject({ version: marker(count + 1).version })
    const sibling = binding('sibling')
    sibling.observe({ type: 'appended', currentRequests: marker(1, 'sibling') })
    await flush()
    expect(registry.pending.size).toBe(2)
    const siblingSend = sends.at(-1)!
    owner.invalidate()
    await flush()
    expect(registry.pending.size).toBe(1)
    expect(registry.pending.has(siblingSend.id)).toBe(true)
    respond(siblingSend.id, marker(1, 'sibling'))
    await flush()
    expect(currentMessageQuestionView(states.get('sibling') ?? {})?.ready).toBe(true)
    expect(currentMessageQuestionView(states.get('target') ?? {})?.ready).not.toBe(true)
    // A fresh eligible reader succeeds after actual aborted work settles.
    const next = binding('next')
    next.observe({ type: 'appended', currentRequests: marker(count + 2) })
    await flush()
    respond(sends.at(-1)!.id, marker(count + 2))
    await flush()
    expect(currentMessageQuestionView(states.get('next') ?? {})?.ready).toBe(true)
    const timeout = binding('timeout')
    timeout.observe({ type: 'appended', currentRequests: marker(1, 'timeout') })
    await flush()
    expect(registry.pending.size).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    timeout.invalidate()
    await flush()
    expect(registry.pending.size).toBe(0)
    expect(active).toBe(0)
    expect(settled).toBe(call.mock.calls.length)
    // A drain rejects only actual outstanding work and leaves all correlation entries empty.
    const drain = binding('drain')
    drain.observe({ type: 'appended', currentRequests: marker(1, 'drain') })
    await flush()
    expect(registry.pending.size).toBe(1)
    drain.invalidate()
    registry.rejectAll('connection drained')
    await flush()
    expect(registry.pending.size).toBe(0)
    expect(active).toBe(0)
    const disposalSends = sends.length
    if (phase === 'before-connect') {
      connecting = true
      connection = new Promise<void>((resolve) => {
        unblock = resolve
      })
    }
    for (let i = 0; i < count; i++) {
      const disposed = binding(`disposed-${i}`)
      disposed.observe({ type: 'appended', currentRequests: marker(1, `disposed-${i}`) })
      await flush()
      disposed.invalidate()
      await flush()
      expect(registry.pending.size).toBe(0)
    }
    if (phase === 'before-connect') {
      expect(active).toBeLessThanOrEqual(8)
      expect(sends).toHaveLength(disposalSends)
      connecting = false
      unblock()
      await flush()
      expect(sends).toHaveLength(disposalSends)
    } else {
      expect(sends.length - disposalSends).toBe(count)
    }
    expect(active).toBe(0)
    expect(registry.pending.size).toBe(0)
    console.log('browser-registry-drain', {
      count,
      phase,
      entries: serial,
      sends: sends.length,
      settled
    })
  }
)
