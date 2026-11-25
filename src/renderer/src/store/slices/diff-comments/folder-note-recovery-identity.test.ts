import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import { MAX_PENDING_FOLDER_NOTE_ACTIONS, protectedCopies } from './folder-note-protected-copy'
import { FOLDER_NOTE_READ_TIMEOUT_MS } from './folder-note-reconcile'
import {
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
  vi.useRealTimers()
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
const pairedMethods = () =>
  runtimeEnvironmentCall.mock.calls
    .map(([args]) => args.method as string)
    .filter((method) => method.startsWith('folderWorkspace.'))

describe('folder note recovery across a replaced row', () => {
  it('shows none of the old row’s queued work when the row is replaced before its save fails', async () => {
    const { host, add, shown, store, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v0')
    ])
    const gate = deferred()
    host.ordinaryGate = gate.promise
    host.nextOrdinary = 'refuse'
    const failing = add('W', 2)
    const queued = add('B', 3)
    host.row = { ...host.row, createdAt: 8, diffComments: [note('Q', 'new row')] }
    await startCatalogFetch().deliver()
    const published: string[][] = []
    const unsubscribe = store.subscribe(() => published.push(shown()))
    gate.resolve()

    expect(await failing).toBeNull()
    expect(await queued).toBeNull()
    unsubscribe()
    expect(published.every((list) => bodies(list).every((body) => body === 'new row'))).toBe(true)
    expect(host.effects).toMatchObject({ ordinary: 0, merges: 0 })
    // The first save made on the successor is an ordinary one of its own.
    expect(await add('S', 4)).not.toBeNull()
    expect(host.effects.ordinary).toBe(1)
    expect(bodies(host.notes())).toEqual(['new row', 'S'])
  })

  it('lets a write already out on the old row settle its own caller, and sends nothing after it', async () => {
    const { host, add, failOnce, shown, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v0')
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    const first = add('Y', 2)
    const second = add('Z', 3)
    await vi.waitFor(() => expect(host.requests.at(-1)?.mode).toBe('merge'))
    // The catalog already lists a successor; the host still applies the write sent to the old row.
    await startCatalogFetch({
      ...host.row,
      createdAt: 8,
      diffComments: [note('Q', 'new row')]
    }).deliver()
    gate.resolve()

    expect(await first).not.toBeNull()
    expect(await second).toBeNull()
    expect(host.requests.filter((request) => request.mode === 'merge')).toHaveLength(1)
    expect(shown()).toEqual(['Q=new row'])
  })

  it('retires the copy when a fetch the note fence holds shows its row replaced', async () => {
    const { host, add, failOnce, startCatalogFetch } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const replacement = { ...host.row, createdAt: 8, diffComments: [note('Q', 'new row')] }
    const held = startCatalogFetch(replacement)
    host.nextMerges = ['ok', 'refuse']
    // In one burst: Y's receipt becomes the base and fences fetches claimed before it; Z fails, so protection stays.
    const [y, z] = await Promise.all([add('Y', 2), add('Z', 3)])
    expect(y).not.toBeNull()
    expect(z).toBeNull()
    expect(protectedCopies.size).toBe(1)

    await held.deliver()

    expect(protectedCopies.size).toBe(0)
  })
})

describe('folder note recovery: what a clear rests on', () => {
  it('still clears when a peer already made the queued delete it rested on', async () => {
    const { host, remove, clear, failOnce, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'x'),
      note('Y', 'y', 2)
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse', 'ok']
    const removed = remove('X')
    host.peer((notes) => notes.filter((entry) => entry.id !== 'X'))
    await startCatalogFetch().deliver()

    const cleared = clear()
    gate.resolve()
    await removed

    expect(await cleared).toBe(true)
    expect(host.notes()).toEqual([])
  })
})

describe('folder note recovery on a paired host', () => {
  it('returns to ordinary saves after a quiet list claimed after the acknowledged tail', async () => {
    const { host, add, failOnce, shown, startCatalogFetch } = setupFolderNotes('paired', [
      huge(),
      note('X', 'v0')
    ])
    await failOnce()
    // No snapshot fits, so only a later list can show the host after this save.
    expect(await add('A2', 2)).not.toBeNull()
    expect(protectedCopies.size).toBe(1)

    await startCatalogFetch().deliver()

    expect(protectedCopies.size).toBe(0)
    expect(ids(shown())).toEqual(ids(host.notes()))
    expect(await add('A3', 3)).not.toBeNull()
    expect(pairedMethods().at(-1)).toBe('folderWorkspace.update')
    expect(host.requests.some((request) => request.mode === 'read')).toBe(false)
  })

  it('stays merge-only when the list was claimed before the acknowledgement', async () => {
    const { add, failOnce, startCatalogFetch } = setupFolderNotes('paired', [
      huge(),
      note('X', 'v0')
    ])
    await failOnce()
    const early = startCatalogFetch()
    expect(await add('A2', 2)).not.toBeNull()

    await early.deliver()

    expect(protectedCopies.size).toBe(1)
    expect(await add('A3', 3)).not.toBeNull()
    expect(pairedMethods().at(-1)).toBe('folderWorkspace.mergeDiffComments')
  })

  it('stays merge-only on an older host that refused, whatever list follows', async () => {
    const { add, failOnce, startCatalogFetch } = setupFolderNotes('paired-older', [note('X', 'v0')])
    await failOnce()
    expect(await add('A2', 2)).toBeNull()

    await startCatalogFetch().deliver()

    expect(await add('A3', 3)).toBeNull()
    expect(pairedMethods().filter((method) => method !== 'folderWorkspace.list')).toEqual([
      'folderWorkspace.update',
      'folderWorkspace.mergeDiffComments',
      'folderWorkspace.mergeDiffComments'
    ])
  })
})

describe('folder note recovery: order, bounds and stalls', () => {
  it('keeps an edited note where the host keeps it when no snapshot can be shown', async () => {
    const { host, add, edit, failOnce, shown } = setupFolderNotes('local', [huge()])
    await failOnce()
    const a = await add('A', 2)
    expect(await add('B', 3)).not.toBeNull()
    expect(await edit(a?.id ?? '', 'A edited')).toBe(true)
    await vi.waitFor(() => expect(host.effects.reads).toBeGreaterThan(3))

    expect(ids(shown())).toEqual(ids(host.notes()))
    expect(bodies(shown()).slice(1)).toEqual(['A edited', 'B'])
  })

  it('may report coalesced saves past the bound as unconfirmed though their write landed', async () => {
    const { host, add, shown } = setupFolderNotes('local', [])
    // The first save is dequeued after every add, so it carries all of them, lands, and loses its reply.
    host.nextOrdinary = 'drop-ack'
    const total = MAX_PENDING_FOLDER_NOTE_ACTIONS + 6
    const results = await Promise.all(Array.from({ length: total }, (_, i) => add(`n${i}`, i + 1)))

    expect(host.notes()).toHaveLength(total)
    expect(results.filter((result) => result === null)).toHaveLength(6)
    expect(host.effects.merges).toBe(MAX_PENDING_FOLDER_NOTE_ACTIONS)
    // "Not saved" means this client could not confirm it; the drained display shows what landed.
    await vi.waitFor(() => expect(shown()).toEqual(host.notes()))
  })

  it('sends the next save once a stalled local read times out, and ignores the late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, add, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    const stall = deferred()
    host.readGate = stall.promise
    await failOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.effects.reads).toBe(1)

    const added = add('Y', 2)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.effects.merges).toBe(0)
    await vi.advanceTimersByTimeAsync(FOLDER_NOTE_READ_TIMEOUT_MS)

    expect(await added).not.toBeNull()
    expect(host.effects.merges).toBe(1)
    const settled = shown()
    host.peer(() => [note('L', 'late')])
    stall.resolve()
    await vi.advanceTimersByTimeAsync(1)
    expect(shown()).toEqual(settled)
  })
})
