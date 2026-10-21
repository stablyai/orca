import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  getRemoteRuntimeSessionTabsInFlightCountForTests,
  listRemoteRuntimeSessionTabsAfterCurrentInFlight,
  listRemoteRuntimeSessionTabsDeduped
} from './remote-runtime-session-tabs-inflight'

const SNAPSHOT = {
  worktree: 'wt-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
} satisfies RuntimeMobileSessionTabsResult

describe('remote runtime session-tabs in-flight requests', () => {
  it('shares one request within an environment/worktree and evicts it after settlement', async () => {
    let resolveLoad: (answer: { snapshot: RuntimeMobileSessionTabsResult }) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<{ snapshot: RuntimeMobileSessionTabsResult }>((resolve) => {
          resolveLoad = resolve
        })
    )
    const args = { environmentId: 'env-1', worktreeId: 'wt-1', load }

    const first = listRemoteRuntimeSessionTabsDeduped(args)
    const second = listRemoteRuntimeSessionTabsDeduped(args)

    expect(load).toHaveBeenCalledOnce()
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(1)
    resolveLoad({ snapshot: SNAPSHOT })
    // Why: a joiner inherits the request's receipt position instead of minting a newer one.
    await expect(Promise.all([first, second])).resolves.toEqual([
      { snapshot: SNAPSHOT, receivedFrame: expect.any(Number) },
      { snapshot: SNAPSHOT, receivedFrame: expect.any(Number) }
    ])
    const [firstAnswer, secondAnswer] = await Promise.all([first, second])
    expect(firstAnswer.receivedFrame).toBe(secondAnswer.receivedFrame)
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(0)

    const followupLoad = vi.fn(async () => ({ snapshot: SNAPSHOT }))
    await listRemoteRuntimeSessionTabsDeduped({
      ...args,
      load: followupLoad
    })
    expect(followupLoad).toHaveBeenCalledOnce()
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(0)
  })

  it('does not share requests across runtime or worktree ownership boundaries', async () => {
    const load = vi.fn(async () => ({ snapshot: SNAPSHOT }))

    await Promise.all([
      listRemoteRuntimeSessionTabsDeduped({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        load
      }),
      listRemoteRuntimeSessionTabsDeduped({
        environmentId: 'env-2',
        worktreeId: 'wt-1',
        load
      }),
      listRemoteRuntimeSessionTabsDeduped({
        environmentId: 'env-1',
        worktreeId: 'wt-2',
        load
      })
    ])

    expect(load).toHaveBeenCalledTimes(3)
  })

  it('waits out an older request before sharing a post-operation inventory', async () => {
    let resolveCurrent: (answer: { snapshot: RuntimeMobileSessionTabsResult }) => void = () => {}
    const currentLoad = vi.fn(
      () =>
        new Promise<{ snapshot: RuntimeMobileSessionTabsResult }>((resolve) => {
          resolveCurrent = resolve
        })
    )
    let resolveFresh: (answer: { snapshot: RuntimeMobileSessionTabsResult }) => void = () => {}
    const freshLoad = vi.fn(
      () =>
        new Promise<{ snapshot: RuntimeMobileSessionTabsResult }>((resolve) => {
          resolveFresh = resolve
        })
    )
    const ownership = { environmentId: 'env-1', worktreeId: 'wt-1' }

    const current = listRemoteRuntimeSessionTabsDeduped({ ...ownership, load: currentLoad })
    const firstFresh = listRemoteRuntimeSessionTabsAfterCurrentInFlight({
      ...ownership,
      load: freshLoad
    })
    const secondFresh = listRemoteRuntimeSessionTabsAfterCurrentInFlight({
      ...ownership,
      load: freshLoad
    })

    expect(freshLoad).not.toHaveBeenCalled()
    resolveCurrent({ snapshot: SNAPSHOT })
    await expect(current.then((answer) => answer.snapshot)).resolves.toBe(SNAPSHOT)
    await vi.waitFor(() => expect(freshLoad).toHaveBeenCalledOnce())
    resolveFresh({ snapshot: { ...SNAPSHOT, snapshotVersion: 2 } })
    await expect(
      Promise.all([firstFresh, secondFresh]).then((answers) =>
        answers.map((answer) => answer.snapshot)
      )
    ).resolves.toEqual([
      { ...SNAPSHOT, snapshotVersion: 2 },
      { ...SNAPSHOT, snapshotVersion: 2 }
    ])
  })
})
