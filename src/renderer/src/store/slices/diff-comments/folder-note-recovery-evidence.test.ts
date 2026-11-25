import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utf8JsonByteLength } from '../../../../../shared/file-review/folder-diff-comment-merge'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES } from './folder-note-merge-call'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import { note, resetFolderNoteTestState, setupFolderNotes } from './folder-note-test-harness'

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
const MiB = 1024 * 1024

describe('folder note recovery: evidence a dependent is judged by', () => {
  it('does not let an older sample vouch for a version a newer verdict saw lose', async () => {
    const { host, store, add, edit, startCatalogFetch } = setupFolderNotes('local', [])
    host.nextOrdinary = 'drop-ack'
    const gate = deferred()
    host.mergeGate = gate.promise
    // One ordinary write carries A and B=v2, lands and loses its reply; B is then replayed.
    const added = [add('A', 1), add('v2', 2)]
    await vi.waitFor(() => expect(host.requests.at(-1)?.mode).toBe('merge'))
    await startCatalogFetch().deliver()
    const later = add('Z', 3)
    const bId = store.getState().folderWorkspaces[0].diffComments?.find((n) => n.body === 'v2')?.id
    // Same value as shown: it rests on B's replay.
    const repeated = edit(bId ?? '', 'v2')
    host.peer((notes) =>
      notes.map((entry) => (entry.id === bId ? { ...entry, body: 'v3' } : entry))
    )
    gate.resolve()

    expect((await Promise.all(added))[1]).toBeNull()
    expect(await repeated).toBe(false)
    expect(await later).not.toBeNull()
    expect(host.requests.filter((request) => request.mode === 'merge')).toHaveLength(2)
    expect(bodies(host.notes())).toEqual(['A', 'v3', 'Z'])
  })

  it('keeps a checked absence for a waiting delivered clear after the copy is released', async () => {
    const { host, edit, clearDelivered, failOnce } = setupFolderNotes('local', [note('X', 'v1')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    const edited = edit('X', 'v2')
    // Both look done only because of the pending edit.
    const cleared = clearDelivered([note('X', 'v1')])
    const repeated = edit('X', 'v2')
    host.peer(() => [])
    gate.resolve()

    expect(await edited).toBe(false)
    expect(await repeated).toBe(false)
    expect(await cleared).toBe(true)
    expect(host.requests.filter((request) => request.mode === 'merge')).toHaveLength(1)
    expect(host.notes()).toEqual([])
  })
})

describe('folder note recovery: where the host placed a replayed add', () => {
  it.each([
    ['still holds it', false, ['A', 'B', 'big']],
    ['lost it to an unseen peer delete', true, ['A', 'big', 'B']]
  ] as const)('shows the host order when the host %s', async (_name, peerDeletesB, expected) => {
    const { host, add, shown, startCatalogFetch } = setupFolderNotes('local', [])
    host.nextOrdinary = 'drop-ack'
    const gate = deferred()
    host.mergeGate = gate.promise
    const added = [add('A', 1), add('B', 2)]
    await vi.waitFor(() => expect(host.requests.at(-1)?.mode).toBe('merge'))
    // Added after the small ordinary write: past the snapshot budget, within a reply.
    host.peer((notes) => [...notes, note('H', `big${'h'.repeat(3 * MiB + 1024)}`, 3)])
    const catalogBytes = utf8JsonByteLength({ folderWorkspaces: [host.row] })
    await startCatalogFetch().deliver()
    if (peerDeletesB) {
      host.peer((notes) => notes.filter((entry) => entry.body !== 'B'))
    }
    gate.resolve()
    await Promise.all(added)

    const order = () => bodies(shown()).map((body) => body.slice(0, 3))
    expect(order()).toEqual(expected)
    await vi.waitFor(() => expect(host.effects.reads).toBeGreaterThan(0))
    expect(order()).toEqual(expected)
    expect(ids(shown())).toEqual(ids(host.notes()))
    await startCatalogFetch().deliver()
    expect(order()).toEqual(expected)

    const replay = host.requests.find((request) => request.mode === 'merge')
    const receipt = host.receipts.find((entry) => entry.outcome === 'applied')
    // Request and reply measured apart: each well inside its own paired budget.
    expect(utf8JsonByteLength(replay)).toBeLessThan(2048)
    expect(utf8JsonByteLength(replay)).toBeLessThan(FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES)
    expect(receipt && 'snapshot' in receipt ? receipt.snapshot : undefined).toBeUndefined()
    expect(utf8JsonByteLength(receipt)).toBeLessThan(2048)
    expect(catalogBytes).toBeGreaterThan(3 * MiB)
    expect(catalogBytes).toBeLessThan(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
  })
})
