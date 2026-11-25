import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderDiffCommentMergeRequest } from '../../../../../shared/file-review/folder-diff-comment-merge'
import { utf8JsonByteLength } from '../../../../../shared/file-review/folder-diff-comment-merge'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import type { FolderOwner } from './folder-note-actions'
import { protectedCopies } from './folder-note-protected-copy'
import {
  FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES,
  FolderNoteWriteNotSentError,
  mergeFolderDiffComments
} from './folder-note-merge-call'
import { diffCommentQueueEntriesForTests } from './diff-comment-persistence'
import {
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

const bodies = (entries: string[]) => entries.map((entry) => entry.split('=')[1])
const ids = (entries: string[]) => entries.map((entry) => entry.split('=')[0])
const huge = () => note('H', 'h'.repeat(3 * 1024 * 1024))

describe('folder note recovery: what the display rests on', () => {
  it('keeps a peer note a refresh showed while the failing ordinary save was out', async () => {
    const { host, add, shown, startCatalogFetch } = setupFolderNotes('local', [note('X', 'v0')])
    const gate = deferred()
    host.ordinaryGate = gate.promise
    host.nextOrdinary = 'refuse'
    host.nextReads = ['fail']
    const added = add('Y', 2)
    host.peer((notes) => [...notes, note('P', 'peer', 3)])
    await startCatalogFetch().deliver()
    gate.resolve()

    expect(await added).toBeNull()
    await vi.waitFor(() => expect(host.requests.map((request) => request.mode)).toEqual(['read']))
    await vi.waitFor(() => expect(bodies(shown())).toEqual(['v0', 'peer']))
  })

  it('never publishes a fetch sampled before an acknowledged note without that note', async () => {
    const { host, add, failOnce, refresh, store, shown, startCatalogFetch } = setupFolderNotes(
      'local',
      [note('X', 'v0')]
    )
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const stale = startCatalogFetch()
    const write = deferred()
    const read = deferred()
    host.mergeGate = write.promise
    host.readGate = read.promise
    const added = add('Y', 2)
    await vi.waitFor(() => expect(host.requests.at(-1)?.mode).toBe('merge'))
    // Replaced while the write is out, so its receipt can't become the base.
    refresh()
    write.resolve()
    expect(await added).not.toBeNull()
    await vi.waitFor(() => expect(host.effects.reads).toBe(2))

    const published: string[][] = []
    const unsubscribe = store.subscribe(() => published.push(shown()))
    await stale.deliver()
    unsubscribe()
    read.resolve()

    expect(published.length).toBeGreaterThan(0)
    expect(published.every((list) => bodies(list).includes('Y'))).toBe(true)
    await vi.waitFor(() => expect(bodies(shown())).toEqual(['v0', 'Y']))
  })

  it('shows nothing of a replaced row on its successor, and sends nothing more for it', async () => {
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
    host.row = { ...host.row, createdAt: 8, diffComments: [note('Q', 'new row')] }

    await startCatalogFetch().deliver()
    expect(shown()).toEqual(['Q=new row'])
    gate.resolve()

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(host.requests.filter((request) => request.mode === 'merge')).toHaveLength(1)
    expect(shown()).toEqual(['Q=new row'])
    expect(protectedCopies.size).toBe(0)
  })

  it('shows a peer deletion an acknowledged mark-sent confirmed, even without a snapshot', async () => {
    const { host, failOnce, markSent, shown } = setupFolderNotes('local', [huge(), note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    host.peer((notes) => notes.filter((entry) => entry.id !== 'X'))

    expect(await markSent(['X'])).toBe(true)

    await vi.waitFor(() => expect(host.effects.reads).toBe(2))
    expect(ids(shown())).toEqual(['H'])
  })
})

describe('folder note recovery: results for the whole scope', () => {
  it('reports a clear as not saved when the delete it rested on failed', async () => {
    const { host, remove, clear, failOnce, shown } = setupFolderNotes('local', [
      note('X', 'x'),
      note('Y', 'y', 2)
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse']

    const removed = remove('X')
    // The pending delete hides X, so this clear itself only deletes Y.
    const cleared = clear()
    gate.resolve()
    await removed

    expect(await cleared).toBe(false)
    await vi.waitFor(() => expect(shown()).toEqual(host.notes()))
    expect(ids(shown())).toContain('X')
  })

  it('reports a repeated edit by the latest queued edit of that note', async () => {
    const { host, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse', 'ok']

    const first = edit('X', 'v1')
    const second = edit('X', 'v2')
    const repeated = edit('X', 'v2')
    gate.resolve()

    expect(await Promise.all([first, second, repeated])).toEqual([false, true, true])
    expect(host.notes()).toEqual(['X=v2'])
    await vi.waitFor(() => expect(shown()).toEqual(['X=v2']))
  })

  it('settles the caller by the verdict and drops a snapshot that contradicts it', async () => {
    const { host, add, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    folderWorkspacesApi.mergeDiffComments.mockImplementationOnce(async (request) => ({
      ...(await host.merge(request)),
      snapshot: []
    }))

    expect(await add('Y', 2)).not.toBeNull()

    await vi.waitFor(() => expect(bodies(shown())).toEqual(['v0', 'Y']))
  })
})

describe('folder note recovery: retained state', () => {
  it('keeps one confirmation per note across repeated small edits on a row too large to return', async () => {
    const { host, edit, failOnce } = setupFolderNotes('local', [huge(), note('X', 'v0')])
    await failOnce()
    for (const body of ['v1', 'v2', 'v3', 'v4']) {
      expect(await edit('X', body)).toBe(true)
    }
    await vi.waitFor(() => expect(host.effects.reads).toBe(5))

    const copies = [...protectedCopies.values()]
    expect(copies.map((copy) => copy.confirmed.size)).toEqual([1])
  })

  it('frees the queue and the copy once a read ends a burst, and the copy when its row goes', async () => {
    const { host, failOnce, startCatalogFetch } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))

    await vi.waitFor(() => expect(diffCommentQueueEntriesForTests()).toBe(0))
    const [copy] = [...protectedCopies.values()]
    expect(copy).toMatchObject({ pending: [], authoritative: undefined })

    folderWorkspacesApi.list.mockImplementationOnce(async () => [])
    await startCatalogFetch().deliver().catch(() => {})
    await vi.waitFor(() => expect(protectedCopies.size).toBe(0))
  })
})

describe('folder note recovery: paired request size', () => {
  function requestWithBody(body: string): FolderDiffCommentMergeRequest {
    return {
      requestId: 'r1',
      folderWorkspaceId: 'folder-1',
      expectedCreatedAt: 7,
      mode: 'merge',
      diffCommentsBase: [],
      diffComments: [note('A', body)]
    }
  }

  it('sends a request of exactly the budget, escapes and multibyte text included, and not one byte more', async () => {
    const { owner } = setupFolderNotes('paired')
    const folder = owner() as FolderOwner
    const remaining = FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES - utf8JsonByteLength(requestWithBody(''))
    // '€' is three UTF-8 bytes and '"' is escaped to two, so each pair is five.
    const body = '€"'.repeat(Math.floor(remaining / 5)) + 'a'.repeat(remaining % 5)
    expect(utf8JsonByteLength(requestWithBody(body))).toBe(FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES)

    await expect(mergeFolderDiffComments(folder, requestWithBody(body))).resolves.toMatchObject({
      outcome: 'applied'
    })
    const calls = runtimeEnvironmentCall.mock.calls.length
    await expect(mergeFolderDiffComments(folder, requestWithBody(`${body}a`))).rejects.toThrow(
      FolderNoteWriteNotSentError
    )
    expect(runtimeEnvironmentCall.mock.calls.length).toBe(calls)
  })
})
