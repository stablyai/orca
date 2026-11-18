// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'

const mocks = vi.hoisted(() => {
  const current: { run: GoogleSetupRun | null } = { run: null }
  return { current, call: vi.fn() }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/lib/bot-catalog', () => ({ openBotHomeTab: vi.fn() }))

import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import {
  answerGoogleSetup,
  resetGoogleSetupRunsForTest,
  useGoogleSetupBlocker,
  useGoogleSetupRun
} from './google-setup-run-store'

function run(id: string, state: GoogleSetupRun['state']): GoogleSetupRun {
  return {
    id,
    botId: 'ivy',
    state,
    mode: 'do-it-for-me',
    steps: {},
    answers: {},
    startedAt: 1,
    updatedAt: 1,
    revision: 1
  }
}

beforeEach(() => {
  resetGoogleSetupRunsForTest()
  mocks.call.mockReset().mockImplementation(async () => ({ run: mocks.current.run }))
})
afterEach(cleanup)

describe('a bot setup run as its cards read it', () => {
  it('reads again for a card from a run started since, once', async () => {
    mocks.current.run = run('old', 'done')
    const first = renderHook(() => useGoogleSetupRun({ hostId: 'local', id: 'ivy' }, 'old'))
    await waitFor(() => expect(first.result.current?.id).toBe('old'))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    mocks.current.run = run('new', 'done')
    const next = renderHook(() => useGoogleSetupRun({ hostId: 'local', id: 'ivy' }, 'new'))
    await waitFor(() => expect(next.result.current?.id).toBe('new'))
    expect(first.result.current?.id).toBe('new')
    // The old card is now from an earlier run, and asks nothing more.
    await act(async () => {})
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it('reads again when the host says bots changed, and stops listening when no card shows', async () => {
    mocks.current.run = run('one', 'running')
    const card = renderHook(() => useGoogleSetupRun({ hostId: 'local', id: 'ivy' }, 'one'))
    await waitFor(() => expect(card.result.current?.state).toBe('running'))
    mocks.current.run = { ...run('one', 'done'), revision: 2 }
    act(() => {
      emitBotsChangedWindowEvent('local')
    })
    await waitFor(() => expect(card.result.current?.state).toBe('done'))
    const calls = mocks.call.mock.calls.length
    card.unmount()
    emitBotsChangedWindowEvent('local')
    await act(async () => {})
    expect(mocks.call).toHaveBeenCalledTimes(calls)
  })

  it('takes the run and where it’s stuck from one reply, so a new run never shows old buttons', async () => {
    const stuck = { kind: 'no-key', actions: [{ id: 'make-new-key' }, { id: 'import-key' }] }
    mocks.call.mockImplementation(async () => ({ run: run('one', 'running'), blocker: stuck }))
    const card = renderHook(() => ({
      run: useGoogleSetupRun({ hostId: 'local', id: 'ivy' }, 'one'),
      blocker: useGoogleSetupBlocker({ hostId: 'local', id: 'ivy' })
    }))
    await waitFor(() => expect(card.result.current.blocker).toEqual(stuck))
    // Make a new key: the answer's reply carries the moved run and no blocker.
    mocks.call.mockImplementation(async () => ({
      run: { ...run('one', 'running'), revision: 2 },
      blocker: null
    }))
    await act(() => answerGoogleSetup({ hostId: 'local', id: 'ivy' }, 'step', ['redo', 'client']))
    expect(card.result.current.run?.revision).toBe(2)
    expect(card.result.current.blocker).toBeNull()
  })

  it('drops a read that comes back after a later reply', async () => {
    mocks.current.run = run('one', 'running')
    const card = renderHook(() => useGoogleSetupRun({ hostId: 'local', id: 'ivy' }, 'one'))
    await waitFor(() => expect(card.result.current?.state).toBe('running'))
    let late: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
    act(() => {
      emitBotsChangedWindowEvent('local')
    })
    mocks.call.mockImplementationOnce(async () => ({ run: { ...run('one', 'done'), revision: 3 } }))
    await act(() => answerGoogleSetup({ hostId: 'local', id: 'ivy' }, 'step', ['resume']))
    expect(card.result.current?.state).toBe('done')
    await act(async () => {
      late({ run: { ...run('one', 'running'), revision: 2 } })
    })
    expect(card.result.current?.state).toBe('done')
  })
})
