/** Repeated title-driven persists with unchanged host-visible layout must dedupe to one remote push; count at the IPC boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'

const updateWebRuntimePaneLayout = vi.fn()
vi.mock('@/runtime/hosted-terminals/actions/web-runtime-pane-layout-update', () => ({
  updateWebRuntimePaneLayout: (...args: unknown[]) => updateWebRuntimePaneLayout(...args)
}))

const { createRemotePaneLayoutPusher } = await import('./remote-pane-layout-push')
const { notePendingPaneTitleRename } =
  await import('@/runtime/web-session-tabs-sync/naming/pending-pane-title-renames')
const { toRemoteRuntimePtyId } =
  await import('../../../../../../shared/remote-runtime/remote-runtime-pty-id')

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
})
