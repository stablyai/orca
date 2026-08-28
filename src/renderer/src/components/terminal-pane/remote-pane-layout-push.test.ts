/**
 * Perf regression: layout persists fire on pane-title churn, and every one of
 * them used to push a remote-runtime IPC round trip regardless of whether the
 * host-visible layout had moved. Counting invocations at the mocked IPC boundary
 * pins the before/after: 100 persists with an unchanged layout cost 100 pushes
 * before the dedupe and 1 after.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const updateWebRuntimePaneLayout = vi.fn()
vi.mock('@/runtime/web-runtime-session', () => ({
  updateWebRuntimePaneLayout: (...args: unknown[]) => updateWebRuntimePaneLayout(...args)
}))

const { createRemotePaneLayoutPusher } = await import('./remote-pane-layout-push')

const PERSISTS = 100

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function makeLayout(overrides: Partial<TerminalLayoutSnapshot> = {}): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    },
    activeLeafId: 'leaf-a',
    expandedLeafId: null,
    ptyIdsByLeafId: { 'leaf-a': 'remote:pty-a', 'leaf-b': 'remote:pty-b' },
    titlesByLeafId: { 'leaf-a': 'build' },
    ...overrides
  }
}

describe('createRemotePaneLayoutPusher', () => {
  beforeEach(() => {
    updateWebRuntimePaneLayout.mockReset().mockResolvedValue(true)
  })

  it('pushes once across 100 persists of an unchanged layout', () => {
    const pusher = createRemotePaneLayoutPusher()
    for (let i = 0; i < PERSISTS; i += 1) {
      // Fresh object each time: persistLayoutSnapshot re-serializes on every call.
      pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    }
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(1)
  })

  it('sends the same payload the un-deduped path sent', () => {
    const pusher = createRemotePaneLayoutPusher()
    const layout = makeLayout()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      root: layout.root,
      expandedLeafId: layout.expandedLeafId,
      titlesByLeafId: layout.titlesByLeafId
    })
  })

  it('omits titlesByLeafId when the layout carries no titles', () => {
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout({ titlesByLeafId: undefined })
    })
    expect(updateWebRuntimePaneLayout.mock.calls[0][0]).not.toHaveProperty('titlesByLeafId')
  })

  it('pushes again for every host-visible change', () => {
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    pusher.push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout({ expandedLeafId: 'leaf-a' })
    })
    pusher.push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout({
        expandedLeafId: 'leaf-a',
        titlesByLeafId: { 'leaf-a': 'test' }
      })
    })
    pusher.push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout({
        expandedLeafId: 'leaf-a',
        titlesByLeafId: { 'leaf-a': 'test' },
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.7,
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        }
      })
    })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(4)
  })

  it('pushes again when a remote pane swaps its pty', () => {
    // ptyIdsByLeafId is not in the payload, but a swap means a different host session.
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    pusher.push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout({ ptyIdsByLeafId: { 'leaf-a': 'remote:pty-c', 'leaf-b': 'remote:pty-b' } })
    })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
  })

  it('does not carry a cached layout across tabs', () => {
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-2', layout: makeLayout() })
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(3)
  })

  it('does not carry a cached layout across worktrees', () => {
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    pusher.push({ worktreeId: 'wt-2', tabId: 'tab-1', layout: makeLayout() })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
  })

  it('retries an unchanged layout after a failed push', async () => {
    updateWebRuntimePaneLayout.mockResolvedValueOnce(false)
    const pusher = createRemotePaneLayoutPusher()
    const input = { worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() }

    pusher.push(input)
    await Promise.resolve()
    pusher.push(input)

    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale failure invalidate a newer in-flight layout', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    updateWebRuntimePaneLayout.mockImplementationOnce(() => first.promise)
    updateWebRuntimePaneLayout.mockImplementationOnce(() => second.promise)
    const pusher = createRemotePaneLayoutPusher()
    const changedLayout = makeLayout({ expandedLeafId: 'leaf-a' })

    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: changedLayout })
    first.resolve(false)
    await Promise.resolve()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: changedLayout })

    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
    second.resolve(true)
  })

  it('re-pushes after a remount re-establishes host geometry', () => {
    const pusher = createRemotePaneLayoutPusher()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })
    createRemotePaneLayoutPusher().push({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      layout: makeLayout()
    })
    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
  })
})
