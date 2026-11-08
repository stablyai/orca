import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import {
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
