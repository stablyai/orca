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
    let resolveLoad: (snapshot: RuntimeMobileSessionTabsResult) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<RuntimeMobileSessionTabsResult>((resolve) => {
          resolveLoad = resolve
        })
    )
    const args = { environmentId: 'env-1', worktreeId: 'wt-1', load }

    const first = listRemoteRuntimeSessionTabsDeduped(args)
    const second = listRemoteRuntimeSessionTabsDeduped(args)

    expect(load).toHaveBeenCalledOnce()
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(1)
    resolveLoad(SNAPSHOT)
    await expect(Promise.all([first, second])).resolves.toEqual([SNAPSHOT, SNAPSHOT])
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(0)

    const followupLoad = vi.fn(async () => SNAPSHOT)
    await listRemoteRuntimeSessionTabsDeduped({
      ...args,
      load: followupLoad
    })
    expect(followupLoad).toHaveBeenCalledOnce()
    expect(getRemoteRuntimeSessionTabsInFlightCountForTests()).toBe(0)
  })

  it('does not share requests across runtime or worktree ownership boundaries', async () => {
    const load = vi.fn(async () => SNAPSHOT)

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
    let resolveCurrent: (snapshot: RuntimeMobileSessionTabsResult) => void = () => {}
    const currentLoad = vi.fn(
      () =>
        new Promise<RuntimeMobileSessionTabsResult>((resolve) => {
          resolveCurrent = resolve
        })
    )
    let resolveFresh: (snapshot: RuntimeMobileSessionTabsResult) => void = () => {}
    const freshLoad = vi.fn(
      () =>
        new Promise<RuntimeMobileSessionTabsResult>((resolve) => {
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
    resolveCurrent(SNAPSHOT)
    await expect(current).resolves.toBe(SNAPSHOT)
    await vi.waitFor(() => expect(freshLoad).toHaveBeenCalledOnce())
    resolveFresh({ ...SNAPSHOT, snapshotVersion: 2 })
    await expect(Promise.all([firstFresh, secondFresh])).resolves.toEqual([
      { ...SNAPSHOT, snapshotVersion: 2 },
      { ...SNAPSHOT, snapshotVersion: 2 }
    ])
  })
})
