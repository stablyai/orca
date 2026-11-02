// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerAutoCloseState } from '../../../shared/worker-auto-close'

const mocks = vi.hoisted(() => ({
  worker: Boolean(true)
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({
    autoClose: { kept: false, closesAt: '2026-10-27T12:02:00Z' }
  })),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: vi.fn(async () => {}),
  readLocalRuntimeCapabilitiesOrUnknown: () => ['orchestration.worker-keep-open.v1']
}))
vi.mock('@/runtime/visible-agent-orchestration', () => ({
  selectVisibleAgentOrchestration: () =>
    mocks.worker
      ? { 'tab:leaf': { taskId: 't', dispatchId: 'd', dispatchStatus: 'completed' } }
      : {}
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ agentStatusByPaneKey: {} })
}))

import { useWorkerAutoClose } from './worker-auto-close'

const TARGET = { kind: 'local' as const }
const SUBJECT = { paneKey: 'tab:leaf' }
let latest: WorkerAutoCloseState | null = null

function Probe(): null {
  latest = useWorkerAutoClose(TARGET, SUBJECT, 'tab:leaf', true).state
  return null
}

describe('useWorkerAutoClose', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    vi.useRealTimers()
  })

  it('stops its countdown clock and forgets the state once the pane is no longer a worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(Probe)))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(latest).toEqual({ kept: false, closesAt: '2026-10-27T12:02:00Z' })

    mocks.worker = false
    await act(async () => root!.render(createElement(Probe)))

    expect(latest).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
