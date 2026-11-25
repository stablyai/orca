import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import {
  compatibilityGate,
  folderWorkspacesApi,
  note,
  resetFolderNoteTestState,
  runtimeEnvironmentCall,
  setupFolderNotes
} from './folder-note-test-harness'

let errSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCache()
  clearRuntimeEnvironmentConnectionGenerations()
  resetFolderNoteTestState()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
})

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const ids = (entries: string[]) => entries.map((entry) => entry.split('=')[0])
const bodies = (entries: string[]) => entries.map((entry) => entry.split('=')[1])
const huge = () => note('H', 'h'.repeat(3 * 1024 * 1024))
const mergeHandoffs = () =>
  runtimeEnvironmentCall.mock.calls.filter(
    ([args]) => args.method === 'folderWorkspace.mergeDiffComments'
  ).length

describe('folder note recovery: a paired send after retirement', () => {
  it('never hands a merge to the host once the copy retired during the compatibility wait', async () => {
    const { host, add, failOnce, startCatalogFetch } = setupFolderNotes('paired', [note('X', 'v0')])
    await failOnce()
    // A catalog request already out; its answer will show the row recreated.
    const list = startCatalogFetch({
      ...host.row,
      createdAt: 8,
      diffComments: [note('Q', 'new row')]
    })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toContain(
        'folderWorkspace.list'
      )
    )
    clearRuntimeCompatibilityCache()
    const compatibility = deferred()
    compatibilityGate.current = compatibility.promise
    const added = add('Y', 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    await list.deliver()
    compatibility.resolve()

    expect(await added).toBeNull()
    expect(mergeHandoffs()).toBe(0)
    expect(host.effects.merges).toBe(0)
  })
})

describe('folder note recovery: what a dependent action asked for', () => {
  it('does not take a provisional floor as proof that a note is gone', async () => {
    const { host, add, remove, clear, store } = setupFolderNotes('local', [note('Y', 'y')])
    const gate = deferred()
    host.ordinaryGate = gate.promise
    host.nextOrdinary = 'drop-ack'
    const addedX = add('X', 2)
    await vi.waitFor(() => expect(folderWorkspacesApi.update).toHaveBeenCalled())
    const xId = store.getState().folderWorkspaces[0].diffComments?.find((n) => n.body === 'X')?.id
    host.nextMerges = ['refuse']
    const removed = remove(xId ?? '')
    const cleared = clear()
    gate.resolve()

    expect(await addedX).toBeNull()
    await removed
    expect(await cleared).toBe(false)
    expect(bodies(host.notes())).toContain('X')
  })

  it('reports a repeated edit as not saved once the edit it rested on lost to a peer delete', async () => {
    const { host, edit, failOnce } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    const first = edit('X', 'v1')
    const repeated = edit('X', 'v1')
    host.peer(() => [])
    gate.resolve()

    expect(await first).toBe(false)
    expect(await repeated).toBe(false)
  })

  it('clears what was delivered when a peer already moved the other note out of that delivery', async () => {
    const { host, edit, clearDelivered, failOnce, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v1'),
      note('Y', 'y', 2)
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const delivered = [note('X', 'v1'), note('Y', 'y', 2)]
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse', 'ok']
    const edited = edit('X', 'v2')
    host.peer((notes) =>
      notes.map((entry) => (entry.id === 'X' ? { ...entry, body: 'v3' } : entry))
    )
    await startCatalogFetch().deliver()

    const cleared = clearDelivered(delivered)
    gate.resolve()

    expect(await edited).toBe(false)
    expect(await cleared).toBe(true)
    expect(host.notes()).toEqual(['X=v3'])
  })

  it('still refuses that clear when the delivered note genuinely rests on the failed edit', async () => {
    const { host, edit, clearDelivered, failOnce, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v1'),
      note('Y', 'y', 2)
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const delivered = [note('X', 'v1'), note('Y', 'y', 2)]
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse']
    const edited = edit('X', 'v2')
    await startCatalogFetch().deliver()

    const cleared = clearDelivered(delivered)
    gate.resolve()

    expect(await edited).toBe(false)
    expect(await cleared).toBe(false)
    expect(host.notes()).toEqual(['X=v1', 'Y=y'])
  })
})

describe('folder note recovery: confirmed position', () => {
  it('keeps a replayed add where the accepted host list already holds it', async () => {
    const { host, add, shown, startCatalogFetch } = setupFolderNotes('local', [huge()])
    host.nextOrdinary = 'drop-ack'
    const gate = deferred()
    host.mergeGate = gate.promise
    // One ordinary write carries A and B, lands, and loses its reply; B is then replayed.
    const added = [add('A', 2), add('B', 3)]
    await vi.waitFor(() => expect(host.requests.at(-1)?.mode).toBe('merge'))
    host.peer((notes) => [...notes, note('P', 'peer', 4)])
    await startCatalogFetch().deliver()
    gate.resolve()

    const [a, b] = await Promise.all(added)
    expect(a).toBeNull()
    expect(b).not.toBeNull()
    expect(bodies(host.notes()).slice(1)).toEqual(['A', 'B', 'peer'])
    await vi.waitFor(() => expect(ids(shown())).toEqual(ids(host.notes())))
  })
})
