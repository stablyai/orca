import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from './store-test-helpers'
import {
  diffCommentTwinHostId,
  selectWorktreeDiffCommentsOrEmpty
} from '../worktree-diff-comments-selector'

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
  return store.getState().addDiffComment({
    worktreeId: WT,
    filePath: 'README.md',
    lineNumber: 1,
    body: 'ssh note',
    side: 'modified'
  })
}

beforeEach(() => {
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

  it('refuses when no host names the twin instead of editing both', async () => {
    const store = createTwinStore(null)

    expect(await addNote(store)).toBeNull()

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
    store.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })

    expect(await store.getState().clearDeliveredDiffComments(WT, [sent])).toBe(true)

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
    expect(updateMeta.mock.calls[0][0]).not.toHaveProperty('executionHostId')
  })

  it('saves an open unstamped row its SSH repo owns', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      repos: [{ ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }],
      worktreesByRepo: { [REPO]: [worktree(undefined)] }
    })

    expect(await addNote(store)).not.toBeNull()

    expect(updateMeta.mock.calls[0][0]).not.toHaveProperty('executionHostId')
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
    const store = createTwinStore(null)
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
    const store = createTwinStore(null)
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

  it('names the paired server for a proxied SSH twin, as rival servers share the target', () => {
    expect(diffCommentTwinHostId({ hostId: 'ssh:box', runtimeOwnerEnvironmentId: 'hub-a' })).toBe(
      'runtime:hub-a'
    )
  })

  it('edits the duplicate row the notes panel shows', async () => {
    const store = createTwinStore(null)
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local'), worktree('local', [note('l1', 'old')])] }
    })

    expect(await store.getState().updateDiffComment(WT, 'l1', 'new')).toBe(true)

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

    await store.getState().deleteDiffComment(WT, 'u1')

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

    await store.getState().clearDiffComments(WT)

    expect(updateMeta).not.toHaveBeenCalled()
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('still saves a lone unstamped row a listing stamps and rebuilds before the save runs', async () => {
    const store = createTwinStore(null)
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
