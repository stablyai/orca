import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import { resetFolderNoteProtectionForTests } from './folder-note-protection'
import { resetFolderNotesFenceForTests } from './folder-note-fence'
import {
  folderWorkspacesApi,
  note,
  runtimeEnvironmentCall,
  setupFolderNotes
} from './folder-note-test-harness'
import { FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES } from './folder-note-merge-call'

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCache()
  clearRuntimeEnvironmentConnectionGenerations()
  resetFolderNoteProtectionForTests()
  resetFolderNotesFenceForTests()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
})

describe('folder notes after a failed save', () => {
  it.each(['local', 'paired'] as const)(
    "keeps the other device's note and the landed one: the ticket sequence (%s)",
    async (kind) => {
      const { host, add, shown } = setupFolderNotes(kind)
      host.nextOrdinary = 'drop-ack'
      expect(await add('A')).toBeNull()
      expect(host.notes()).toEqual([expect.stringMatching(/=A$/)])
      host.peer((notes) => [...notes, note('P', 'from another device', 2)])

      expect(await add('A2')).not.toBeNull()

      expect(host.notes().map((entry) => entry.split('=')[1])).toEqual([
        'A',
        'from another device',
        'A2'
      ])
      await vi.waitFor(() =>
        expect(shown().map((entry) => entry.split('=')[1])).toEqual(['A', 'from another device', 'A2'])
      )
    }
  )

  it('refuses with zero writes on an older server, stays protected across a refresh, and resumes after an upgrade', async () => {
    const { host, add, refresh, shown } = setupFolderNotes('paired-older')
    host.nextOrdinary = 'drop-ack'
    expect(await add('A')).toBeNull()
    host.peer((notes) => [...notes, note('P', 'from another device', 2)])
    const writesBefore = host.effects.ordinary

    expect(await add('A2')).toBeNull()
    expect(host.notes().map((entry) => entry.split('=')[1])).toEqual(['A', 'from another device'])
    expect(host.effects.ordinary).toBe(writesBefore)

    refresh()
    expect(await add('A3')).toBeNull()
    expect(host.effects.ordinary).toBe(writesBefore)
    expect(shown().map((entry) => entry.split('=')[1])).toEqual(['A', 'from another device'])

    host.supportsMerge = true
    expect(await add('A4')).not.toBeNull()
    expect(host.notes().map((entry) => entry.split('=')[1])).toEqual([
      'A',
      'from another device',
      'A4'
    ])
    // Acknowledged: protection ends, so the next save is an ordinary one again.
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalled())
    const ordinaryBefore = host.effects.ordinary
    expect(await add('A5')).not.toBeNull()
    expect(host.effects.ordinary).toBe(ordinaryBefore + 1)
  })

  it('shows the confirmed note again after three queued edits are all refused', async () => {
    const { host, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.nextMerges = ['refuse', 'refuse', 'refuse']

    const results = await Promise.all([edit('X', 'v1'), edit('X', 'v2'), edit('X', 'v3')])

    expect(results).toEqual([false, false, false])
    expect(host.notes()).toEqual(['X=v0'])
    expect(shown()).toEqual(['X=v0'])
  })

  it('applies a reverted edit even when the first edit landed with its reply lost', async () => {
    const { host, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.nextMerges = ['drop-ack', 'ok']

    const results = await Promise.all([edit('X', 'v1'), edit('X', 'v0')])

    expect(results).toEqual([false, true])
    expect(host.notes()).toEqual(['X=v0'])
    await vi.waitFor(() => expect(shown()).toEqual(['X=v0']))
  })

  it('reports each queued action by its own outcome', async () => {
    const { host, add, edit, failOnce, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.peer(() => [])

    const [added, edited] = await Promise.all([add('Y', 2), edit('X', 'v1')])

    expect(added).not.toBeNull()
    expect(edited).toBe(false)
    expect(host.notes().map((entry) => entry.split('=')[1])).toEqual(['Y'])
    await vi.waitFor(() => expect(shown().map((entry) => entry.split('=')[1])).toEqual(['Y']))
  })

  it('orders this copy’s own acknowledged writes causally even when the host clock steps back', async () => {
    const { host, add, failOnce, shown } = setupFolderNotes('local')
    await failOnce()
    host.clock = 100
    expect(await add('first')).not.toBeNull()
    host.clock = 90
    expect(await add('second', 2)).not.toBeNull()

    await vi.waitFor(() =>
      expect(shown().map((entry) => entry.split('=')[1])).toEqual(['first', 'second'])
    )
  })

  it('refuses a write to a recreated row with zero effects', async () => {
    const { host, add, failOnce } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.row = { ...host.row, createdAt: 8 }
    const before = host.notes()

    expect(await add('Y', 2)).toBeNull()

    expect(host.notes()).toEqual(before)
    expect(host.effects.merges).toBe(0)
  })

  it('never sends a paired request over the sealed-frame budget, counting escaped UTF-8', async () => {
    const { host, add, failOnce } = setupFolderNotes('paired')
    await failOnce()
    const merges = host.requests.length
    // Three UTF-8 bytes per character: well under the limit in characters, over it in bytes.
    const body = '€'.repeat(Math.ceil(FOLDER_NOTE_MERGE_MAX_PARAMS_BYTES / 3) + 1)

    expect(await add(body)).toBeNull()

    expect(host.requests.length).toBe(merges)
    expect(host.effects.merges).toBe(0)
  })

  it('reconciles a contested display with a read that writes nothing', async () => {
    const { host, add, failOnce, refresh, shown } = setupFolderNotes('local', [note('X', 'v0')])
    await failOnce()
    host.mergeGate = new Promise((resolve) => setTimeout(resolve, 0))
    const pending = add('Y', 2)
    host.peer((notes) => [...notes, note('P', 'peer', 3)])
    // A refresh published while the write is in flight: the receipt alone can't say which is newer.
    refresh()
    expect(await pending).not.toBeNull()

    await vi.waitFor(() =>
      expect(shown().map((entry) => entry.split('=')[1])).toEqual(['v0', 'peer', 'Y'])
    )
    expect(host.requests.at(-1)?.mode).toBe('read')
    expect(host.effects.reads).toBeGreaterThan(0)
  })

  it('keeps an ordinary save as before when nothing failed', async () => {
    const { host, add } = setupFolderNotes('local', [note('X', 'v0')])

    expect(await add('Y', 2)).not.toBeNull()

    expect(host.effects).toMatchObject({ ordinary: 1, merges: 0 })
    expect(folderWorkspacesApi.mergeDiffComments).not.toHaveBeenCalled()
    expect(folderWorkspacesApi.update.mock.calls[0][0].updates).toEqual({
      diffComments: [note('X', 'v0'), expect.objectContaining({ body: 'Y' })],
      diffCommentsBase: [note('X', 'v0')]
    })
  })
})
