import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import { overlayFolderNotes, type FolderNoteAction } from './folder-note-actions'
import { MAX_PENDING_FOLDER_NOTE_ACTIONS } from './folder-note-protected-copy'
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

describe('folder note recovery: what this copy shows', () => {
  it('replays pending actions in call order: a delete then re-add goes last, like the host', () => {
    const action = (delta: [string, DiffComment | undefined][]): FolderNoteAction =>
      ({ delta: new Map(delta), before: new Map() }) as FolderNoteAction
    const base = [note('a', 'a'), note('b', 'b'), note('c', 'c')]

    const shown = overlayFolderNotes(base, new Map(), [
      action([['a', undefined]]),
      action([['d', note('d', 'd')]]),
      action([['a', note('a', 'a2')]]),
      action([['b', note('b', 'b2')]])
    ])

    expect(shown.map((entry) => entry.body)).toEqual(['b2', 'c', 'd', 'a2'])
  })

  it('keeps an acknowledged add and the host list when the next queued edit fails', async () => {
    const { host, add, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.peer((notes) => [...notes, note('P', 'peer', 3)])
    host.nextMerges = ['ok', 'refuse']

    const [added, edited] = await Promise.all([add('Y', 2), edit('X', 'v1')])

    expect(added).not.toBeNull()
    expect(edited).toBe(false)
    await vi.waitFor(() => expect(bodies(shown())).toEqual(['v0', 'peer', 'Y']))
  })

  it('reports a same-value edit by the outcome of the queued edit it rests on', async () => {
    const { host, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse']

    const first = edit('X', 'v1')
    // The display already shows v1, so this edit changes nothing of its own.
    const repeated = edit('X', 'v1')
    gate.resolve()

    expect(await first).toBe(false)
    expect(await repeated).toBe(false)
    expect(shown()).toEqual(['X=v0'])
  })

  it('reports an apparently empty clear by the outcome of the queued delete', async () => {
    const { host, remove, clear, store, failOnce, shown } = setupFolderNotes('local', [
      note('X', 'v0')
    ])
    await failOnce()
    const gate = deferred()
    host.mergeGate = gate.promise
    host.nextMerges = ['refuse']
    const owner = () => store.getState().folderWorkspaces[0]

    const removed = remove('X')
    expect(owner().diffComments).toEqual([])
    const cleared = clear()
    gate.resolve()
    await removed

    expect(await cleared).toBe(false)
    expect(shown()).toEqual(['X=v0'])
  })

  it('lets a genuinely empty clear succeed at once on a protected copy', async () => {
    const { clear, failOnce } = setupFolderNotes('local', [])
    await failOnce()

    expect(await clear()).toBe(true)
  })
})

describe('folder note recovery: reads and catalog fetches', () => {
  it('discards a read that an equal-valued catalog fetch overtook, then reads again', async () => {
    const { host, store, failOnce, shown, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v0')
    ])
    const gate = deferred()
    host.readGate = gate.promise
    host.peer(() => [note('X', 'v1')])
    await failOnce()
    // The reconciling read sampled v1 and is still in flight; the peer reverts to what is shown.
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    host.peer(() => [note('X', 'v0')])
    host.readGate = undefined
    // The fetched row equals the shown one, so the store keeps its arrays: nothing visibly changes.
    const before = store.getState().folderWorkspaces
    await startCatalogFetch(store.getState().folderWorkspaces[0]).deliver()
    expect(store.getState().folderWorkspaces).toBe(before)
    gate.resolve()

    await vi.waitFor(() => expect(host.effects.reads).toBe(2))
    await vi.waitFor(() => expect(shown()).toEqual(['X=v0']))
  })

  it('keeps notes from a receipt when a fetch sampled before it lands later, even after recovery ends', async () => {
    const { host, add, failOnce, shown, startCatalogFetch } = setupFolderNotes('local', [
      note('X', 'v0')
    ])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const stale = startCatalogFetch()

    expect(await add('Y', 2)).not.toBeNull()
    await stale.deliver()

    expect(bodies(shown())).toEqual(['v0', 'Y'])
    // A fetch started afterwards replaces the notes as usual.
    host.peer((notes) => [...notes, note('P', 'peer', 3)])
    await startCatalogFetch().deliver()
    expect(bodies(shown())).toEqual(['v0', 'Y', 'peer'])
  })

  it('shows a new action during the read at once and sends it only after the read', async () => {
    const { host, add, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    const gate = deferred()
    host.readGate = gate.promise
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))

    const added = add('Y', 2)
    expect(bodies(shown())).toEqual(['v0', 'Y'])
    expect(host.effects.merges).toBe(0)
    gate.resolve()

    expect(await added).not.toBeNull()
    expect(host.requests.map((request) => request.mode)).toEqual(['read', 'merge'])
    await vi.waitFor(() => expect(bodies(shown())).toEqual(['v0', 'Y']))
  })

  it('stops reading after a failed read and recovers on a real refresh', async () => {
    const { host, add, shown, startCatalogFetch } = setupFolderNotes('local', [note('X', 'v0')])
    host.nextReads = ['fail']
    host.nextOrdinary = 'drop-ack'
    expect(await add('refused', 2)).toBeNull()
    await vi.waitFor(() => expect(host.requests.length).toBe(1))
    // The failed write landed; the display can't know until the host answers.
    expect(shown()).toEqual(['X=v0'])

    await startCatalogFetch().deliver()

    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    expect(bodies(shown())).toEqual(['v0', 'refused'])
    expect(host.effects.merges).toBe(0)
  })

  // Why: a paired route's preparation can rebuild an SSH tunnel or restart a stopped server.
  it.each(['paired', 'paired-older'] as const)(
    'never reads a %s host on its own; only the user\'s saves go out',
    async (kind) => {
      const { add, failOnce, startCatalogFetch } = setupFolderNotes(kind, [note('X', 'v0')])
      await failOnce()
      await add('A2', 2)
      await startCatalogFetch().deliver()
      await add('A3', 3)
      const modes = runtimeEnvironmentCall.mock.calls
        .filter(([args]) => args.method === 'folderWorkspace.mergeDiffComments')
        .map(([args]) => args.params.mode)
      // An older host refuses both; a current one ends protection with the first acknowledged save.
      expect(modes).toEqual(kind === 'paired' ? ['merge'] : ['merge', 'merge'])
    }
  )

  it('confirms a small edit on a row too large to return, and says once that it could not show it', async () => {
    const huge = note('H', 'h'.repeat(3 * 1024 * 1024))
    const { host, edit, failOnce } = setupFolderNotes('local', [huge, note('X', 'v0')])
    await failOnce()

    expect(await edit('X', 'v1')).toBe(true)

    expect(host.notes().at(-1)).toBe('X=v1')
    await vi.waitFor(() => expect(host.effects.reads).toBeGreaterThan(0))
    await vi.waitFor(() => expect(host.effects.reads).toBe(2))
    const reports = warnSpy.mock.calls.filter(([message]) =>
      String(message).includes('could not return the full note list')
    )
    expect(reports).toHaveLength(1)
  })
})

describe('folder note recovery: bounded backlog', () => {
  it('refuses an action beyond the protected backlog bound before showing or sending it', async () => {
    const { host, add, failOnce, shown } = setupFolderNotes('local', [])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    const gate = deferred()
    host.mergeGate = gate.promise
    const queued = Array.from({ length: MAX_PENDING_FOLDER_NOTE_ACTIONS }, (_, index) =>
      add(`n${index}`, index + 1)
    )
    const beyond = add('beyond', 999)
    expect(bodies(shown())).not.toContain('beyond')
    gate.resolve()

    const results = await Promise.all(queued)

    expect(results.every((result) => result !== null)).toBe(true)
    expect(await beyond).toBeNull()
    expect(host.effects.merges).toBe(MAX_PENDING_FOLDER_NOTE_ACTIONS)
  })

  it('keeps the bound when an ordinary backlog crosses into protection', async () => {
    const { host, add } = setupFolderNotes('local', [])
    const gate = deferred()
    host.ordinaryGate = gate.promise
    host.nextOrdinary = 'refuse'
    const queued = Array.from({ length: MAX_PENDING_FOLDER_NOTE_ACTIONS + 5 }, (_, index) =>
      add(`n${index}`, index + 1)
    )
    gate.resolve()

    const results = await Promise.all(queued)

    expect(results[0]).toBeNull()
    // The failed save and the four past the bound; the bound's worth are sent merge-only.
    expect(results.filter((result) => result === null)).toHaveLength(5)
    expect(host.effects.merges).toBe(MAX_PENDING_FOLDER_NOTE_ACTIONS)
  })
})

describe('folder note recovery: replies it cannot trust', () => {
  it.each([
    [
      'answers another request',
      (request: { requestId: string }) => ({ requestId: `${request.requestId}x` })
    ],
    ['names another row', () => ({ folderWorkspaceId: 'folder-2' })],
    ['comes from a recreated row', () => ({ createdAt: 99 })],
    ['has a malformed verdict', () => ({ verdict: [{ id: 1 }] })],
    [
      'names a note it did not touch',
      (_request: { requestId: string }, receipt: { verdict: unknown[] }) => ({
        verdict: [...receipt.verdict, { id: 'extra', version: '' }]
      })
    ]
  ])('treats a receipt that %s as unconfirmed and stays protected', async (_name, corrupt) => {
    const { host, add, failOnce } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    await vi.waitFor(() => expect(host.effects.reads).toBe(1))
    folderWorkspacesApi.mergeDiffComments.mockImplementationOnce(async (request) => {
      const receipt = await host.merge(request)
      return { ...receipt, ...corrupt(request, receipt as { verdict: unknown[] }) }
    })

    expect(await add('Y', 2)).toBeNull()

    // Still protected: the next save is merge-only again.
    const ordinary = host.effects.ordinary
    expect(await add('Z', 3)).not.toBeNull()
    expect(host.effects.ordinary).toBe(ordinary)
  })
})
