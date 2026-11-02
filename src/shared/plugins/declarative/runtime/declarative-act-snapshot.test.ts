import { afterEach, describe, expect, it } from 'vitest'
import {
  atom,
  persistedEntry,
  read,
  resetAtoms,
  set,
  watchPersistedAtoms,
  type OrcaAtom
} from './declarative-atoms'
import { actSnapshotSubscriptions } from './declarative-act-snapshot'

function fakeBridge() {
  const handlers = new Map<string, (payload: unknown) => void>()
  return {
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return { dispose: () => handlers.delete(event) }
    },
    send: (event: string, payload: unknown) => handlers.get(event)?.(payload)
  }
}

afterEach(() => {
  watchPersistedAtoms(null)
  resetAtoms()
})

describe('shot --act atom snapshot', () => {
  it('puts every plugin-written atom back, re-persisting the persisted ones', () => {
    const tab = atom('snapshot.tab', 'all', { persist: 'plugin' })
    const draft = atom('snapshot.draft', '')
    const count = atom(0)
    const persisted: unknown[] = []
    watchPersistedAtoms((target: OrcaAtom<unknown>) => persisted.push(persistedEntry(target)))
    const bridge = fakeBridge()
    actSnapshotSubscriptions(bridge.on, 'doc-1')

    bridge.send('ui.snapshot', { document: 'doc-1' })
    set(tab, 'done')
    set(draft, 'Ship')
    set(count, 3)
    persisted.length = 0
    bridge.send('ui.restore', { document: 'doc-1' })

    expect([read(tab), read(draft), read(count)]).toEqual(['all', '', 0])
    expect(persisted).toEqual([{ scope: 'plugin', key: 'snapshot.tab', version: 1, value: 'all' }])
  })

  it("ignores another document's messages and restores at most once", () => {
    const count = atom(1)
    const bridge = fakeBridge()
    actSnapshotSubscriptions(bridge.on, 'doc-1')
    bridge.send('ui.snapshot', { document: 'doc-2' })
    set(count, 2)
    bridge.send('ui.restore', { document: 'doc-1' })
    expect(read(count)).toBe(2)

    bridge.send('ui.snapshot', { document: 'doc-1' })
    set(count, 5)
    bridge.send('ui.restore', { document: 'doc-1' })
    set(count, 6)
    bridge.send('ui.restore', { document: 'doc-1' })
    expect(read(count)).toBe(6)
  })
})
