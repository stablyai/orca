/** Repeated title-driven persists with unchanged host-visible layout must dedupe to one remote push; count at the IPC boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const updateWebRuntimePaneLayout = vi.fn()
vi.mock('@/runtime/web-runtime-terminal-actions', () => ({
  updateWebRuntimePaneLayout: (...args: unknown[]) => updateWebRuntimePaneLayout(...args)
}))

const { createRemotePaneLayoutPusher } = await import('./remote-pane-layout-push')
const { notePendingPaneTitleRename } = await import('@/runtime/pending-pane-title-renames')
const { toRemoteRuntimePtyId } = await import('../../../../shared/remote-runtime-pty-id')

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
      chatLeafId: null,
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

  it('publishes owner changes and an explicit clear without a geometry change', () => {
    const pusher = createRemotePaneLayoutPusher()
    for (const chatLeafId of ['leaf-a', 'leaf-b', undefined]) {
      pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout({ chatLeafId }) })
    }
    expect(updateWebRuntimePaneLayout.mock.calls.map(([args]) => args.chatLeafId)).toEqual([
      'leaf-a',
      'leaf-b',
      null
    ])
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

  it('names a renamed pane in its push, and again in the retry after that push fails', async () => {
    const remote = { 'leaf-a': toRemoteRuntimePtyId('pty-a', 'env-1') }
    notePendingPaneTitleRename({
      leafId: 'leaf-a',
      title: 'renamed',
      layout: makeLayout({ ptyIdsByLeafId: remote })
    })
    const pusher = createRemotePaneLayoutPusher()
    const renamed = makeLayout({ titlesByLeafId: { 'leaf-a': 'renamed' } })

    updateWebRuntimePaneLayout.mockResolvedValueOnce(false)
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: renamed })
    await Promise.resolve()
    await Promise.resolve()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: renamed })
    await Promise.resolve()
    await Promise.resolve()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout: makeLayout() })

    const sent = updateWebRuntimePaneLayout.mock.calls.map(([args]) => args)
    expect(sent[0]).toMatchObject({ renamedLeafIds: ['leaf-a'] })
    expect(sent[1]).toMatchObject({ renamedLeafIds: ['leaf-a'] })
    expect(sent[2]).not.toHaveProperty('renamedLeafIds')
  })

  it('sends a rename back to the title the last push carried', () => {
    const remote = { 'leaf-b': toRemoteRuntimePtyId('pty-b', 'env-1') }
    const pusher = createRemotePaneLayoutPusher()
    const layout = makeLayout()
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout })
    // The host renamed leaf-b meanwhile; the user names it back to what the last push held.
    notePendingPaneTitleRename({
      leafId: 'leaf-b',
      title: null,
      layout: makeLayout({ ptyIdsByLeafId: remote, titlesByLeafId: { 'leaf-b': 'host' } })
    })
    pusher.push({ worktreeId: 'wt-1', tabId: 'tab-1', layout })

    expect(updateWebRuntimePaneLayout).toHaveBeenCalledTimes(2)
    expect(updateWebRuntimePaneLayout.mock.calls[1]?.[0]).toMatchObject({
      renamedLeafIds: ['leaf-b']
    })
  })
})
