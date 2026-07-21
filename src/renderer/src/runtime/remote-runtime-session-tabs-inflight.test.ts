import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  getRemoteRuntimeSessionTabsInFlightCountForTests,
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
})
