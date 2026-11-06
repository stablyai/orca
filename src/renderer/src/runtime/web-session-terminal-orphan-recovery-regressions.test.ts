import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import '../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  ENVIRONMENT_ID,
  deferred,
  listResult,
  makeSnapshot,
  makeState
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
describe('web session terminal orphan recovery regressions', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('coalesces degraded frames to one active and one latest queued recovery', async () => {
    const worktree = 'repo::coalesce'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const frames = [1, 2, 3].map((version) => makeSnapshot(worktree, `frame-${version}`, leaves))
    const listOne = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const listTwo = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const calls = vi.fn(({ method }: { method: string }) => {
      if (method !== 'terminal.list') {
        throw new Error(`unexpected method ${method}`)
      }
      return calls.mock.calls.length === 1 ? listOne.promise : listTwo.promise
    })

    const first = recoverWebSessionTerminalOrphansBeforeApply(state, frames[0]!, ENVIRONMENT_ID, {
      call: calls as never
    })
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
    const superseded = recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frames[1]!,
      ENVIRONMENT_ID,
      { call: calls as never }
    )
    const latest = recoverWebSessionTerminalOrphansBeforeApply(state, frames[2]!, ENVIRONMENT_ID, {
      call: calls as never
    })

    await expect(superseded).resolves.toBeNull()
    listOne.resolve({ ok: true, result: listResult(worktree, []) })
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2))
    listTwo.resolve({ ok: true, result: listResult(worktree, []) })

    await expect(first).resolves.toBeNull()
    await expect(latest).resolves.toEqual(
      expect.objectContaining({
        tabs: [expect.objectContaining({ status: 'ready', terminal: 'term-live' })]
      })
    )
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('lets a newer fully ready frame overtake an in-flight degraded recovery', async () => {
    const worktree = 'repo::ready-overtake'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const degraded = makeSnapshot(worktree, 'degraded', leaves)
    const ready: RuntimeMobileSessionTabsResult = {
      ...degraded,
      publicationEpoch: 'ready',
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-1',
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          title: 'Live',
          isActive: true,
          status: 'ready' as const,
          terminal: 'term-live'
        }
      ]
    }
    const list = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const call = vi.fn(() => list.promise)
    const stale = recoverWebSessionTerminalOrphansBeforeApply(state, degraded, ENVIRONMENT_ID, {
      call: call as never
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, ready, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toBe(ready)
    list.resolve({ ok: true, result: listResult(worktree, []) })
    await expect(stale).resolves.toBeNull()
  })
})
