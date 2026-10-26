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

/** Import after harness module reset so hook and assertions share the same real row store. */
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

  // Subscribe before hydration so older snapshots cannot erase pages pushed during the round trip.
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
    expect(readRows(WT)).toHaveLength(1)

    harness.clientHostedBrowserRowsChanged({ worktreeId: WT, rows: [] })

    expect(readRows(WT)).toEqual([])
  })

  // Failed hydration must settle and drain buffered pushes or the host strip stays empty forever.
  it('applies pushes after the hydration round trip fails', async () => {
    const { harness, readRows } = await mountHook({
      clientHostedBrowserRowsSnapshotError: new Error('runtime unreachable')
    })

    harness.clientHostedBrowserRowsChanged(pushEvent())
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
