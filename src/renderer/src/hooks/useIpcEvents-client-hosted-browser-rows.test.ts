/**
 * Drives the real push seam end to end on the renderer side: the real useIpcEvents subscription,
 * the real hydration round trip, the real row store, and the real strip placement rule.
 */
import { describe, expect, it } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../../shared/client-hosted-browser-rows'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type IpcEventsHarness,
  type IpcEventsHarnessOptions
} from './ipc-events-test-harness'

const WT = 'wt-1'

function pushEvent(): ClientHostedBrowserRowsEvent {
  return {
    worktreeId: WT,
    rows: [
      {
        browserPageId: 'page-a',
        worktreeId: WT,
        url: 'https://client-hosted.test/docs',
        title: 'Docs',
        loading: false,
        browserHostClientId: 'host-a',
        hostDeviceName: 'Studio',
        hostAbsent: false
      }
    ]
  }
}

/**
 * The harness resets the module registry, so the hook subscribes against a fresh copy of the row
 * store. Importing it here — after the reset — is what makes this an integration test rather than
 * two unrelated module instances agreeing about nothing.
 */
async function mountHook(options: IpcEventsHarnessOptions = {}): Promise<{
  harness: IpcEventsHarness
  readRows: (worktreeId: string) => readonly { browserPageId: string }[]
}> {
  const harness = await loadIpcEventsHarness(
    createHarnessStoreState({ tabsByWorktree: {} }),
    options
  )
  const { getClientHostedBrowserRows } =
    await import('@/lib/pane-manager/client-hosted-browser-row-state')
  harness.useIpcEvents()
  return { harness, readRows: getClientHostedBrowserRows }
}

describe('useIpcEvents client-hosted browser rows', () => {
  it('lands a pushed row in the store the host strip reads', async () => {
    const { harness, readRows } = await mountHook()
    await harness.settleClientHostedBrowserRowsSnapshot()

    harness.clientHostedBrowserRowsChanged(pushEvent())

    expect(readRows(WT)).toEqual(pushEvent().rows)
  })

  it('hydrates rows that existed before this window attached', async () => {
    const { harness, readRows } = await mountHook({
      clientHostedBrowserRowsSnapshot: [pushEvent()]
    })

    expect(readRows(WT)).toEqual([])
    await harness.settleClientHostedBrowserRowsSnapshot()

    expect(readRows(WT).map((row) => row.browserPageId)).toEqual(['page-a'])
  })

  // Why: the subscription is installed before the snapshot round trip, so a page created during
  // that trip must survive the older snapshot landing on top of it.
  it('keeps a push that raced the hydration snapshot', async () => {
    const { harness, readRows } = await mountHook({
      clientHostedBrowserRowsSnapshot: [{ worktreeId: WT, rows: [] }]
    })

    harness.clientHostedBrowserRowsChanged(pushEvent())
    await harness.settleClientHostedBrowserRowsSnapshot()

    expect(readRows(WT).map((row) => row.browserPageId)).toEqual(['page-a'])
  })

  it('retracts the rows when the push empties the worktree', async () => {
    const { harness, readRows } = await mountHook()
    await harness.settleClientHostedBrowserRowsSnapshot()
    harness.clientHostedBrowserRowsChanged(pushEvent())
    // Presence precondition: the retraction below is only meaningful against a live row.
    expect(readRows(WT)).toHaveLength(1)

    harness.clientHostedBrowserRowsChanged({ worktreeId: WT, rows: [] })

    expect(readRows(WT)).toEqual([])
  })

  // Why the failed round trip still has to settle: until it does, every push is buffered instead
  // of applied. A hydration that rejects and never settles means the host strip stays empty for
  // the window's whole life, and nothing on screen says why.
  it('applies pushes after the hydration round trip fails', async () => {
    const { harness, readRows } = await mountHook({
      clientHostedBrowserRowsSnapshotError: new Error('runtime unreachable')
    })

    harness.clientHostedBrowserRowsChanged(pushEvent())
    // Presence precondition: buffered, not applied, while hydration is still outstanding.
    expect(readRows(WT)).toEqual([])
    await harness.settleClientHostedBrowserRowsSnapshot()

    expect(readRows(WT).map((row) => row.browserPageId)).toEqual(['page-a'])
    harness.clientHostedBrowserRowsChanged({ worktreeId: WT, rows: [] })
    expect(readRows(WT)).toEqual([])
  })

  it('leaves other worktrees alone when one is pushed', async () => {
    const { harness, readRows } = await mountHook()
    await harness.settleClientHostedBrowserRowsSnapshot()

    harness.clientHostedBrowserRowsChanged(pushEvent())

    expect(readRows(WT)).toHaveLength(1)
    expect(readRows('wt-2')).toEqual([])
  })
})
