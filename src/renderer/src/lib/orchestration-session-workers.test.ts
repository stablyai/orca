// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted((): { calls: number; workerNotices: boolean } => ({
  calls: 0,
  workerNotices: true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async () => {
    rpc.calls += 1
    return { workers: [], ...(rpc.workerNotices ? { workerNotices: true } : {}) }
  }
}))

import {
  noteOrchestrationSessionWorkersChanged,
  rereadOrchestrationSessionWorkersOnNewRow,
  useOrchestrationSessionsWorkers
} from './orchestration-session-workers'

async function flush(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

afterEach(() => {
  rpc.calls = 0
})

it('reads a chat whose host announces worker events on those events, not on each new row', async () => {
  rpc.workerNotices = true
  const session = ['announcing-chat']
  renderHook(() => useOrchestrationSessionsWorkers({ kind: 'local' }, session, { visible: true }))
  await flush()
  expect(rpc.calls).toBe(1)
  for (let row = 0; row < 5; row += 1) {
    rereadOrchestrationSessionWorkersOnNewRow({ kind: 'local' }, 'announcing-chat')
  }
  await flush()
  expect(rpc.calls).toBe(1)
  noteOrchestrationSessionWorkersChanged(null, 'announcing-chat')
  noteOrchestrationSessionWorkersChanged('other-host', 'announcing-chat')
  await flush()
  expect(rpc.calls).toBe(2)
})

it('keeps re-reading on new rows for an older host that announces nothing', async () => {
  rpc.workerNotices = false
  const session = ['older-host-chat']
  renderHook(() => useOrchestrationSessionsWorkers({ kind: 'local' }, session, { visible: true }))
  await flush()
  rereadOrchestrationSessionWorkersOnNewRow({ kind: 'local' }, 'older-host-chat')
  await flush()
  expect(rpc.calls).toBe(2)
})
