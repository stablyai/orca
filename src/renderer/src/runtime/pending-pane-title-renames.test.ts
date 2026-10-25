import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  PENDING_PANE_TITLE_HOLD_MS,
  requeuePendingPaneTitleRenames,
  notePendingPaneTitleRename,
  takeUnsentPaneTitleRenames,
  withPendingPaneTitleRenames
} from './pending-pane-title-renames'

const remotePty = toRemoteRuntimePtyId('host-pty', 'env-1')
const T0 = 1_000_000

function layoutFor(leafId: string, title?: string, ptyId = remotePty): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId },
    ...(title ? { titlesByLeafId: { [leafId]: title } } : {})
  }
}

function rename(leafId: string, title: string | null, hostTitle = 'old'): void {
  notePendingPaneTitleRename({ leafId, title, layout: layoutFor(leafId, hostTitle), now: T0 })
}

describe('a local pane rename over host snapshots', () => {
  it('outlasts a stale host snapshot, then follows the host once it echoes', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    rename(leafId, 'mine')

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toEqual({
      [leafId]: 'mine'
    })
    expect(withPendingPaneTitleRenames({ [leafId]: 'mine' }, [leafId], T0)).toEqual({
      [leafId]: 'mine'
    })
    // Echoed, so the stale name now wins again if the host goes back to it.
    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toEqual({
      [leafId]: 'old'
    })
  })

  it('holds a local clear the same way', () => {
    const leafId = '22222222-2222-4222-8222-222222222222'
    rename(leafId, null)

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toBeUndefined()
    expect(withPendingPaneTitleRenames(undefined, [leafId], T0)).toBeUndefined()
  })

  it('gives way to a newer host name, such as another client renaming the pane', () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    rename(leafId, 'mine')

    expect(withPendingPaneTitleRenames({ [leafId]: 'theirs' }, [leafId], T0)).toEqual({
      [leafId]: 'theirs'
    })
    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toEqual({
      [leafId]: 'old'
    })
  })

  it('gives way once the hold expires, so an unanswered rename cannot mask the host forever', () => {
    const leafId = '44444444-4444-4444-8444-444444444444'
    rename(leafId, 'mine')
    const later = T0 + PENDING_PANE_TITLE_HOLD_MS

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], later - 1)).toEqual({
      [leafId]: 'mine'
    })
    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], later)).toEqual({
      [leafId]: 'old'
    })
  })

  it('forgets expired holds for panes no snapshot mentions again, such as a closed tab', () => {
    const closed = '99999999-9999-4999-8999-999999999999'
    rename(closed, 'mine')
    withPendingPaneTitleRenames(undefined, [], T0 + PENDING_PANE_TITLE_HOLD_MS)

    expect(takeUnsentPaneTitleRenames([closed])).toEqual([])
  })

  it('names a pane again in the next push after the push carrying it failed', () => {
    const leafId = '55555555-5555-4555-8555-555555555555'
    rename(leafId, 'mine')
    expect(takeUnsentPaneTitleRenames([leafId])).toEqual([leafId])

    requeuePendingPaneTitleRenames([leafId])

    expect(takeUnsentPaneTitleRenames([leafId])).toEqual([leafId])
  })

  it('keeps the latest rename when an earlier one is echoed first', () => {
    const leafId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    rename(leafId, 'first')
    rename(leafId, 'second', 'first')

    expect(withPendingPaneTitleRenames({ [leafId]: 'first' }, [leafId], T0)).toEqual({
      [leafId]: 'second'
    })
    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toEqual({
      [leafId]: 'second'
    })
    expect(withPendingPaneTitleRenames({ [leafId]: 'second' }, [leafId], T0)).toEqual({
      [leafId]: 'second'
    })
  })

  it('names each renamed pane in exactly one push', () => {
    const leafId = '66666666-6666-4666-8666-666666666666'
    const sibling = '77777777-7777-4777-8777-777777777777'
    rename(leafId, 'mine')

    expect(takeUnsentPaneTitleRenames([leafId, sibling])).toEqual([leafId])
    expect(takeUnsentPaneTitleRenames([leafId, sibling])).toEqual([])
  })

  it("holds nothing for a window's own local tab", () => {
    const leafId = '88888888-8888-4888-8888-888888888888'
    notePendingPaneTitleRename({
      leafId,
      title: 'mine',
      layout: layoutFor(leafId, 'old', 'local-pty'),
      now: T0
    })

    expect(takeUnsentPaneTitleRenames([leafId])).toEqual([])
    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId], T0)).toEqual({
      [leafId]: 'old'
    })
  })
})
