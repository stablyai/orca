// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only reached by the valid consumer's frame, after the receipt this test observes.
vi.mock('../../../store/index', () => ({
  useAppStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} }
}))

const { refreshWebRuntimeSessionTabsSnapshot } = await import('./web-runtime-session-snapshot')
const { latestReceivedSessionTabsSnapshotByWorktree, sessionTabsFreshnessKey } =
  await import('../state')

const ENV = 'env-b'
const WT = 'repo::/wt'

/** One held `session.tabs.list` on host B, shared by everyone who asks meanwhile. */
function holdList() {
  let answer: () => void = () => {}
  const call = vi.fn(
    (args: { method: string }) =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            id: args.method,
            ok: true,
            result: {
              worktree: WT,
              publicationEpoch: 'epoch-b',
              snapshotVersion: 4,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            },
            _meta: { runtimeId: 'runtime-b' }
          })
      })
  )
  Object.assign(window, { api: { runtimeEnvironments: { call } } })
  return { call, answer: () => answer() }
}

const receipt = () =>
  latestReceivedSessionTabsSnapshotByWorktree.get(sessionTabsFreshnessKey(ENV, WT))

beforeEach(() => {
  latestReceivedSessionTabsSnapshotByWorktree.clear()
})

describe("a move's reconciliation whose worktree is rerouted while B's list is in flight", () => {
  it('takes no receipt from the list it asked B for', async () => {
    const list = holdList()
    let route = ENV
    const refreshed = refreshWebRuntimeSessionTabsSnapshot(ENV, WT, {
      ownsEffects: () => route === ENV
    })
    await vi.waitFor(() => expect(list.call).toHaveBeenCalledTimes(1), { timeout: 30_000 })

    // The worktree moves to host C before B answers.
    route = 'env-c'
    list.answer()

    await refreshed
    expect(receipt()).toBeUndefined()
  })

  it('leaves a valid consumer of the same list to receive it', async () => {
    const list = holdList()
    let route = ENV
    const stale = refreshWebRuntimeSessionTabsSnapshot(ENV, WT, {
      ownsEffects: () => route === ENV
    })
    // Another consumer of B joins the same in-flight list.
    const valid = refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
    await vi.waitFor(() => expect(list.call).toHaveBeenCalledTimes(1), { timeout: 30_000 })

    route = 'env-c'
    list.answer()
    await Promise.all([stale, valid])

    expect(list.call).toHaveBeenCalledTimes(1)
    expect(receipt()).toBeDefined()
  })
})
