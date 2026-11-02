import type * as RuntimeRpcClient from '../../runtime/runtime-rpc-client'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import {
  diffCommentSendKey,
  holdNotesForSend,
  isNoteInFlight,
  resetNotesInFlightForTests
} from '@/lib/notes-send-in-flight'
import type { AppState } from '../types'
import {
  diffCommentOwnerKey,
  selectDiffCommentView,
  type DiffCommentOwner
} from '../diff-comment-owner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from './store-test-helpers'
import { selectWorktreeDiffCommentsOrEmpty } from '../worktree-diff-comments-selector'

vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const updateMeta = vi.fn()

vi.stubGlobal('window', {
  api: { worktrees: { updateMeta }, ui: { set: vi.fn() } }
})

const REPO = 'repo-1'
const WT = `${REPO}::/work/feature`

function worktree(hostId: Worktree['hostId'], diffComments: DiffComment[] = []): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/work/feature',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId,
    diffComments
  }
}

function note(id: string, body: string): DiffComment {
  return { id, worktreeId: WT, filePath: 'a', lineNumber: 1, body, createdAt: 1, side: 'modified' }
}

const repoBase = {
  id: REPO,
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

// Same project and worktree id on this computer and on an SSH host.
function createTwinStore(activeHostId: Worktree['hostId'] | null) {
  const repos: Repo[] = [
    { ...repoBase, executionHostId: 'local' },
    { ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }
  ]
  const store = createTestStore()
  store.setState({
    activeWorktreeId: activeHostId ? WT : null,
    activeWorkspaceExecutionHostId: activeHostId,
    repos,
    worktreesByRepo: { [REPO]: [worktree('local'), worktree('ssh:box')] }
  })
  return store
}

function rowNotes(store: ReturnType<typeof createTwinStore>, hostId: string): string[] {
  const row = store.getState().worktreesByRepo[REPO].find((w) => w.hostId === hostId)
  return (row?.diffComments ?? []).map((comment) => comment.body)
}

function addNote(store: ReturnType<typeof createTwinStore>) {
  return addNoteFor(store, capturedOwner(store, WT))
}

function addNoteFor(store: ReturnType<typeof createTwinStore>, owner: DiffCommentOwner | null) {
  if (!owner) {
    throw new Error('no workspace')
  }
  return store.getState().addDiffComment(owner, {
    worktreeId: WT,
    filePath: 'README.md',
    lineNumber: 1,
    body: 'ssh note',
    side: 'modified'
  })
}

beforeEach(() => {
  vi.mocked(callRuntimeRpc).mockClear()
  vi.mocked(toast.error).mockClear()
  resetNotesInFlightForTests()
  updateMeta.mockReset()
  updateMeta.mockResolvedValue({})
})

describe('diff comments on twin worktrees', () => {
  it('saves to the open twin and names its host', async () => {
    const store = createTwinStore('ssh:box')

    expect(await addNote(store)).not.toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual(['ssh note'])
    expect(rowNotes(store, 'local')).toEqual([])
    // What the notes panel and diff gutters render.
    expect(selectWorktreeDiffCommentsOrEmpty(store.getState(), WT).map((c) => c.body)).toEqual([
      'ssh note'
    ])
    expect(updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, executionHostId: 'ssh:box' })
    )
  })

  it('rolls back only the twin it wrote', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local', [note('l1', 'local note')]), worktree('ssh:box')]
      }
    })
    updateMeta.mockRejectedValueOnce(new Error('write failed'))

    expect(await addNote(store)).toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('offers no copy to change when no host names one of two twins', () => {
    const store = createTwinStore(null)

    expect(selectDiffCommentView(store.getState(), WT)).toEqual({
      owner: null,
      comments: undefined
    })

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(rowNotes(store, 'local')).toEqual([])
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('drops a queued save whose twin left, instead of writing the other copy under its host', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local', [note('l1', 'local note')]), worktree('ssh:box')]
      }
    })

    const pending = addNote(store)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [note('l1', 'local note')])] } })

    expect(await pending).toBeNull()
    expect(updateMeta).not.toHaveBeenCalled()
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('keeps one queue for a copy when its twin leaves between saves', async () => {
    const store = createTwinStore('ssh:box')
    updateMeta.mockRejectedValue(new Error('write failed'))

    const first = addNote(store)
    // The local copy goes before the second save, so the SSH copy is the only row left.
    store.setState({ worktreesByRepo: { [REPO]: [store.getState().worktreesByRepo[REPO][1]] } })
    const second = addNote(store)

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(rowNotes(store, 'ssh:box')).toEqual([])
  })

  it('writes every duplicated row of one copy, so reads see the note', async () => {
    const store = createTwinStore(null)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local'), worktree('local')] } })

    expect(await addNote(store)).not.toBeNull()

    expect(
      store
        .getState()
        .getDiffComments(WT)
        .map((c) => c.body)
    ).toEqual(['ssh note'])
  })

  it('clears delivered notes on their own copy after the user moved away', async () => {
    const store = createTwinStore('ssh:box')
    const sent = await addNote(store)
    if (!sent) {
      throw new Error('note was not saved')
    }
    const owner = capturedOwner(store, WT)
    store.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })

    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(true)

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(updateMeta).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionHostId: 'ssh:box', updates: { diffComments: [] } })
    )
  })

  it('leaves an unstamped row to the owner its repo names, not this computer', async () => {
    const store = createTwinStore(null)
    store.setState({
      repos: [{ ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }],
      worktreesByRepo: { [REPO]: [worktree(undefined)] }
    })

    expect(await addNote(store)).not.toBeNull()

    expect(updateMeta).toHaveBeenCalledTimes(1)
    expect(updateMeta.mock.calls[0][0]).toHaveProperty('executionHostId', 'ssh:box')
  })

  it('saves an open unstamped row its SSH repo owns', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      repos: [{ ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }],
      worktreesByRepo: { [REPO]: [worktree(undefined)] }
    })

    expect(await addNote(store)).not.toBeNull()

    expect(updateMeta.mock.calls[0][0]).toHaveProperty('executionHostId', 'ssh:box')
  })

  it('picks an SSH twin a paired server proxies by its own stamp', () => {
    const store = createTwinStore('ssh:box')
    const proxied = { ...worktree('ssh:box'), runtimeOwnerEnvironmentId: 'hub' }
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local'), proxied] } })

    // The optimistic write lands synchronously; its transport is not under test here.
    void addNote(store).catch(() => {})

    const ssh = store.getState().worktreesByRepo[REPO][1]
    expect(ssh.diffComments?.map((c) => c.body)).toEqual(['ssh note'])
    expect(rowNotes(store, 'local')).toEqual([])
  })

  it('treats an unstamped row as local when the local twin is open', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined), worktree('ssh:box')] } })

    expect(await addNote(store)).not.toBeNull()

    const [unstamped, ssh] = store.getState().worktreesByRepo[REPO]
    expect(unstamped.diffComments?.map((c) => c.body)).toEqual(['ssh note'])
    expect(ssh.diffComments).toEqual([])
    expect(updateMeta).toHaveBeenCalledWith(expect.objectContaining({ executionHostId: 'local' }))
  })

  it('reads the latest duplicate row of the open copy, as the id index does', () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local'), worktree('ssh:box'), worktree('ssh:box', [note('s1', 'fresh')])]
      }
    })

    expect(selectWorktreeDiffCommentsOrEmpty(store.getState(), WT).map((c) => c.body)).toEqual([
      'fresh'
    ])
  })

  it('keeps saves in order when a listing stamps the row mid-burst', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined)] } })
    let releaseFirst = () => {}
    updateMeta.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = () => resolve({})))
    )

    const first = addNote(store)
    const [row] = store.getState().worktreesByRepo[REPO]
    store.setState({ worktreesByRepo: { [REPO]: [{ ...row, hostId: 'local' }] } })
    const second = addNote(store)
    await Promise.resolve()

    // The second save waits for the first, so the newer list is written last.
    expect(updateMeta).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(updateMeta).toHaveBeenCalledTimes(2)
    expect(updateMeta.mock.calls[1][0].updates.diffComments).toHaveLength(2)
  })

  it('rolls a failed burst back to disk when a listing stamps the row mid-burst', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined)] } })
    updateMeta.mockRejectedValue(new Error('write failed'))

    const first = addNote(store)
    const [row] = store.getState().worktreesByRepo[REPO]
    store.setState({ worktreesByRepo: { [REPO]: [{ ...row, hostId: 'local' }] } })
    const second = addNote(store)

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(rowNotes(store, 'local')).toEqual([])
  })

  it('keeps two paired servers proxying one SSH target apart', () => {
    const store = createTwinStore('runtime:hub-a')
    const viaA = { ...worktree('ssh:box'), runtimeOwnerEnvironmentId: 'hub-a' }
    const viaB = {
      ...worktree('ssh:box', [note('b1', 'hub b note')]),
      runtimeOwnerEnvironmentId: 'hub-b'
    }
    store.setState({ worktreesByRepo: { [REPO]: [viaA, viaB] } })

    expect(selectWorktreeDiffCommentsOrEmpty(store.getState(), WT)).toEqual([])
    void addNote(store).catch(() => {})

    const [a, b] = store.getState().worktreesByRepo[REPO]
    expect(a.diffComments?.map((c) => c.body)).toEqual(['ssh note'])
    expect(b.diffComments?.map((c) => c.body)).toEqual(['hub b note'])
  })

  it("rolls a failed twin write back to its own notes, not the other twin's", async () => {
    const store = createTwinStore('local')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local'), worktree('ssh:box', [note('s1', 'ssh note 1')])]
      }
    })
    let failLocal = (_err: Error) => {}
    updateMeta.mockImplementationOnce(() => new Promise((_resolve, reject) => (failLocal = reject)))

    const local = addNote(store)
    store.setState({ activeWorkspaceExecutionHostId: 'ssh:box' })
    const ssh = addNote(store)
    await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
    failLocal(new Error('write failed'))

    expect(await local).toBeNull()
    expect(await ssh).not.toBeNull()
    expect(rowNotes(store, 'local')).toEqual([])
    expect(rowNotes(store, 'ssh:box')).toEqual(['ssh note 1', 'ssh note'])
  })

  it('edits the duplicate row the notes panel shows', async () => {
    const store = createTwinStore(null)
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local'), worktree('local', [note('l1', 'old')])] }
    })

    expect(await store.getState().updateDiffComment(capturedOwner(store, WT), 'l1', 'new')).toBe(
      true
    )

    expect(updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: { diffComments: [expect.objectContaining({ body: 'new' })] }
      })
    )
  })

  it('sends its own copy when an SSH twin is listed before the queued save runs', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local')] } })

    const pending = addNote(store)
    const [local] = store.getState().worktreesByRepo[REPO]
    store.setState({
      worktreesByRepo: { [REPO]: [local, worktree('ssh:box', [note('s1', 'remote')])] }
    })

    expect(await pending).not.toBeNull()
    expect(
      updateMeta.mock.calls[0][0].updates.diffComments.map((c: DiffComment) => c.body)
    ).toEqual(['ssh note'])
  })

  it('still saves a twin whose row a listing stamps before the queued save runs', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined), worktree('ssh:box')] } })

    const pending = addNote(store)
    const [unstamped, ssh] = store.getState().worktreesByRepo[REPO]
    store.setState({ worktreesByRepo: { [REPO]: [{ ...unstamped, hostId: 'local' }, ssh] } })

    expect(await pending).not.toBeNull()
    expect(rowNotes(store, 'local')).toEqual(['ssh note'])
  })

  it("names the row's own host even when only one copy lists the worktree", async () => {
    // The project is added on both hosts, but this worktree exists only on this computer.
    const store = createTwinStore(null)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local')] } })

    expect(await addNote(store)).not.toBeNull()

    expect(updateMeta).toHaveBeenCalledWith(expect.objectContaining({ executionHostId: 'local' }))
  })

  it('reports a save main refused as failed and rolls it back', async () => {
    const store = createTwinStore('ssh:box')
    updateMeta.mockResolvedValueOnce(null)

    expect(await addNote(store)).toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual([])
  })

  it('refuses a note-id change on an unstamped twin rather than route it by the open one', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree(undefined, [note('u1', 'unstamped')]), worktree('ssh:box')]
      }
    })

    await store.getState().deleteDiffComment(capturedOwner(store, WT), 'u1')

    expect(updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[REPO][0].diffComments?.map((c) => c.body)).toEqual([
      'unstamped'
    ])
  })

  it('never sends a copy listed after a queued save, even after a refresh replaced its notes', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local')] } })
    let releaseFirst = () => {}
    updateMeta.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = () => resolve({})))
    )

    const first = addNote(store)
    const second = addNote(store)
    await vi.waitFor(() => expect(updateMeta).toHaveBeenCalledTimes(1))
    // A refresh rebuilds the local row's list and lists an SSH copy, which the user opens.
    const [local] = store.getState().worktreesByRepo[REPO]
    store.setState({
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: {
        [REPO]: [
          { ...local, diffComments: [...(local.diffComments ?? [])] },
          worktree('ssh:box', [note('s1', 'remote')])
        ]
      }
    })
    releaseFirst()
    await Promise.all([first, second])

    const sent = updateMeta.mock.calls[1][0]
    expect(sent.executionHostId).toBe('local')
    expect(sent.updates.diffComments.map((c: DiffComment) => c.body)).not.toContain('remote')
  })

  it('still saves when a listing stamps the row and rebuilds its notes before the save runs', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined), worktree('ssh:box')] } })

    const pending = addNote(store)
    const [unstamped, ssh] = store.getState().worktreesByRepo[REPO]
    const rebuilt = {
      ...unstamped,
      hostId: 'local' as const,
      diffComments: [...(unstamped.diffComments ?? [])]
    }
    store.setState({ worktreesByRepo: { [REPO]: [rebuilt, ssh] } })

    expect(await pending).not.toBeNull()
    expect(updateMeta).toHaveBeenCalledTimes(1)
  })

  it('refuses a write while the open SSH copy is not listed yet and only its local sibling is', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [note('l1', 'local note')])] } })

    await store.getState().clearDiffComments(capturedOwner(store, WT))

    expect(updateMeta).not.toHaveBeenCalled()
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('still saves a lone unstamped row a listing stamps and rebuilds before the save runs', async () => {
    const store = createTwinStore('local')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined)] } })

    const pending = addNote(store)
    const [row] = store.getState().worktreesByRepo[REPO]
    store.setState({
      worktreesByRepo: {
        [REPO]: [{ ...row, hostId: 'local', diffComments: [...(row.diffComments ?? [])] }]
      }
    })

    expect(await pending).not.toBeNull()
    expect(updateMeta).toHaveBeenCalledTimes(1)
  })
})

function capturedOwner(store: { getState: () => AppState }, worktreeId: string): DiffCommentOwner {
  const { owner } = selectDiffCommentView(store.getState(), worktreeId)
  if (!owner) {
    throw new Error('No copy of the workspace is shown.')
  }
  return owner
}

describe('captured note owners across delivery and selection', () => {
  it('clears only the sent twin after deferred delivery and isolates the in-flight key', async () => {
    const store = createTwinStore('ssh:box')
    const sent = note('same-id', 'same body')
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local', [sent]), worktree('ssh:box', [sent])] }
    })
    const ownerA = capturedOwner(store, WT)
    let deliver = (_result: { delivered: boolean }) => {}
    const delivered = new Promise<{ delivered: boolean }>((resolve) => {
      deliver = resolve
    })
    let cleared: Promise<boolean> | undefined
    holdNotesForSend([diffCommentSendKey(ownerA, sent)], delivered, () => {
      cleared = store.getState().clearDeliveredDiffComments(ownerA, [sent])
    })
    store.setState({ activeWorkspaceExecutionHostId: 'local' })
    const ownerB = capturedOwner(store, WT)
    expect(isNoteInFlight(diffCommentSendKey(ownerA, sent))).toBe(true)
    expect(isNoteInFlight(diffCommentSendKey(ownerB, sent))).toBe(false)
    deliver({ delivered: true })
    await delivered
    expect(await cleared).toBe(true)
    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(rowNotes(store, 'local')).toEqual(['same body'])
    expect(updateMeta).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WT,
      executionHostId: 'ssh:box',
      updates: { diffComments: [] }
    })
    expect(isNoteInFlight(diffCommentSendKey(ownerA, sent))).toBe(false)
  })

  it('keeps add and delete on the captured host after selection changes', async () => {
    const store = createTwinStore('ssh:box')
    const owner = capturedOwner(store, WT)
    store.setState({ activeWorkspaceExecutionHostId: 'local' })
    const saved = await store.getState().addDiffComment(owner, {
      worktreeId: WT,
      filePath: 'a',
      lineNumber: 1,
      body: 'captured',
      side: 'modified'
    })
    expect(saved).not.toBeNull()
    if (!saved) {
      throw new Error('save failed')
    }
    await store.getState().deleteDiffComment(owner, saved.id)
    expect(rowNotes(store, 'local')).toEqual([])
    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(updateMeta).toHaveBeenCalledTimes(2)
    expect(updateMeta.mock.calls.every(([args]) => args.executionHostId === 'ssh:box')).toBe(true)
  })

  it('writes a paired SSH row through its server even when the row names no server', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      repos: [{ ...repoBase, connectionId: 'box', executionHostId: 'runtime:hub' }],
      worktreesByRepo: { [REPO]: [worktree('ssh:box')] }
    })
    const owner = capturedOwner(store, WT)
    store.setState({ activeWorkspaceExecutionHostId: 'local' })

    expect(await addNoteFor(store, owner)).not.toBeNull()

    expect(updateMeta).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'hub' },
      'worktree.set',
      expect.objectContaining({ diffComments: [expect.objectContaining({ body: 'ssh note' })] }),
      expect.anything()
    )
  })

  it('keeps one owner and in-flight Send when a listing stamps the same copy', () => {
    const store = createTwinStore('local')
    const sent = note('n1', 'body')
    store.setState({ worktreesByRepo: { [REPO]: [worktree(undefined, [sent])] } })
    const unstamped = capturedOwner(store, WT)
    holdNotesForSend([diffCommentSendKey(unstamped, sent)], new Promise(() => {}))

    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [sent])] } })
    const stamped = capturedOwner(store, WT)

    expect(diffCommentOwnerKey(stamped)).toBe(diffCommentOwnerKey(unstamped))
    expect(isNoteInFlight(diffCommentSendKey(stamped, sent))).toBe(true)
  })

  it('keeps a composer opened before its SSH copy lists on that copy, never a local row listed first', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [note('l1', 'local')])] } })
    const view = selectDiffCommentView(store.getState(), WT)
    // Unknown, not empty: the selected copy is not listed, and its sibling's notes are not shown.
    expect(view.comments).toBeUndefined()

    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { [REPO]: [worktree(undefined, [note('l1', 'local only')])] }
    })
    expect(await addNoteFor(store, view.owner)).toBeNull()
    expect(updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[REPO][0].diffComments?.map((c) => c.body)).toEqual([
      'local only'
    ])

    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree(undefined, [note('l1', 'local only')]), worktree('ssh:box')]
      }
    })
    expect(await addNoteFor(store, view.owner)).not.toBeNull()
    expect(updateMeta).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WT,
      executionHostId: 'ssh:box',
      updates: { diffComments: [expect.objectContaining({ body: 'ssh note' })] }
    })
  })

  it('keeps a paired SSH capture through its server stamp: queued save, rollback, Send cleanup', async () => {
    const store = createTwinStore('ssh:box')
    const sent = note('n1', 'sent')
    store.setState({
      repos: [{ ...repoBase, connectionId: 'box', executionHostId: 'runtime:hub' }],
      worktreesByRepo: { [REPO]: [worktree('ssh:box', [sent])] }
    })
    const owner = capturedOwner(store, WT)
    let fail = () => {}
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = () => reject(new Error('unreachable'))))
    )
    const pending = addNoteFor(store, owner)
    // The listing confirms the server already captured, before the queued save reads the list.
    const [row] = store.getState().worktreesByRepo[REPO]
    store.setState({ worktreesByRepo: { [REPO]: [{ ...row, runtimeOwnerEnvironmentId: 'hub' }] } })
    expect(diffCommentOwnerKey(capturedOwner(store, WT))).toBe(diffCommentOwnerKey(owner))
    await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledTimes(1))
    expect(vi.mocked(callRuntimeRpc).mock.calls[0][2]).toMatchObject({
      diffComments: [{ body: 'sent' }, { body: 'ssh note' }]
    })
    fail()

    expect(await pending).toBeNull()
    expect(store.getState().worktreesByRepo[REPO][0].diffComments).toEqual([sent])
    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(true)
    expect(store.getState().worktreesByRepo[REPO][0].diffComments).toEqual([])
    expect(callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'hub' },
      'worktree.set',
      expect.objectContaining({ diffComments: [] }),
      expect.anything()
    )
    expect(updateMeta).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()

    // A rival server proxying the same target is another copy.
    store.setState({
      activeWorkspaceExecutionHostId: 'runtime:hub-b',
      worktreesByRepo: {
        [REPO]: [
          ...store.getState().worktreesByRepo[REPO],
          { ...worktree('ssh:box'), runtimeOwnerEnvironmentId: 'hub-b' }
        ]
      }
    })
    expect(diffCommentOwnerKey(capturedOwner(store, WT))).not.toBe(diffCommentOwnerKey(owner))
  })

  it('reports a copy gone since Send or edit once, through the existing failure toast', async () => {
    const store = createTwinStore('ssh:box')
    const sent = note('same-id', 'same body')
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local', [sent]), worktree('ssh:box', [sent])] }
    })
    const owner = capturedOwner(store, WT)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [sent])] } })

    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(false)
    expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith('Failed to clear notes.')
    vi.mocked(toast.error).mockClear()
    expect(await store.getState().updateDiffComment(owner, sent.id, 'edited')).toBe(false)
    expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith('Failed to save comment')
    expect(rowNotes(store, 'local')).toEqual(['same body'])
  })

  it('refuses every mutation when the captured twin was removed', async () => {
    const store = createTwinStore('ssh:box')
    const sent = note('same-id', 'same body')
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local', [sent]), worktree('ssh:box', [sent])] }
    })
    const owner = capturedOwner(store, WT)
    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { [REPO]: [worktree('local', [sent])] }
    })
    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(false)
    expect(await store.getState().clearDiffComments(owner)).toBe(false)
    expect(await store.getState().clearDiffCommentsForFile(owner, 'a')).toBe(false)
    expect(await store.getState().markDiffCommentsSent(owner, [sent.id])).toBe(false)
    expect(await store.getState().updateDiffComment(owner, sent.id, 'changed')).toBe(false)
    await store.getState().deleteDiffComment(owner, sent.id)
    expect(rowNotes(store, 'local')).toEqual(['same body'])
    expect(updateMeta).not.toHaveBeenCalled()
  })
})

it('keeps the paired server write authority when two servers proxy the same target', async () => {
  const store = createTwinStore('runtime:hub-a')
  const sent = note('same-id', 'same body')
  store.setState({
    worktreesByRepo: {
      [REPO]: [
        { ...worktree('ssh:box', [sent]), runtimeOwnerEnvironmentId: 'hub-a' },
        { ...worktree('ssh:box', [sent]), runtimeOwnerEnvironmentId: 'hub-b' }
      ]
    }
  })
  const owner = capturedOwner(store, WT)
  store.setState({ activeWorkspaceExecutionHostId: 'runtime:hub-b' })
  expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(true)
  expect(store.getState().worktreesByRepo[REPO].map((row) => row.diffComments?.length)).toEqual([
    0, 1
  ])
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'hub-a' },
    'worktree.set',
    expect.objectContaining({ diffComments: [] }),
    { timeoutMs: 15_000 }
  )
  expect(updateMeta).not.toHaveBeenCalled()
})
