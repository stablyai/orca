import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/editor-autosave'
import type * as RuntimeFileClientModule from '@/runtime/runtime-file-client'

const store = vi.hoisted(() => {
  const openFiles: Record<string, unknown>[] = []
  return {
    state: { openFiles, setExternalMutation: vi.fn(), setPendingLiveDiskVerification: vi.fn() }
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosaveModule>()
  return { ...actual, notifyEditorExternalFileChange: vi.fn() }
})
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClientModule>()
  return { ...actual, statRuntimePath: vi.fn() }
})

import { notifyEditorExternalFileChange } from '@/components/editor/editor-autosave'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import {
  captureEditorWatchDiskBaseline,
  collectEditorWatchCatchUpEvents,
  holdEditorAutosaveDuringCatchUp
} from './editor-external-watch-catch-up'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

const target: EditorExternalWatchTarget = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

function editTab(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `/repo/${name}`,
    worktreeId: 'wt-1',
    filePath: `/repo/${name}`,
    relativePath: name,
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

type DiskEntry = { size: number; mtime: number } | 'missing' | 'offline'

function stubDisk(disk: Record<string, DiskEntry>): void {
  vi.mocked(statRuntimePath).mockImplementation(async (_context, filePath) => {
    const entry = disk[filePath]
    if (entry === undefined || entry === 'missing') {
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`)
    }
    if (entry === 'offline') {
      throw new Error('SSH connection lost')
    }
    return { ...entry, isDirectory: false }
  })
}

const setExternalMutation = store.state.setExternalMutation

function stubOpenFiles(openFiles: Record<string, unknown>[]): void {
  store.state.openFiles = openFiles
}

describe('editor watch catch-up', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports nothing for files unchanged since the watch was dropped', async () => {
    stubOpenFiles([editTab('a.ts')])
    stubDisk({ '/repo/a.ts': { size: 1, mtime: 1 } })
    const baseline = await captureEditorWatchDiskBaseline(target)

    expect(await collectEditorWatchCatchUpEvents(target, baseline)).toEqual([])
  })

  it('synthesizes update, delete and create events from size and mtime', async () => {
    stubOpenFiles([
      editTab('grown.ts'),
      editTab('touched.ts'),
      editTab('gone.ts'),
      editTab('back.ts')
    ])
    stubDisk({
      '/repo/grown.ts': { size: 1, mtime: 1 },
      '/repo/touched.ts': { size: 1, mtime: 1 },
      '/repo/gone.ts': { size: 1, mtime: 1 },
      '/repo/back.ts': 'missing'
    })
    const baseline = await captureEditorWatchDiskBaseline(target)
    stubDisk({
      '/repo/grown.ts': { size: 2, mtime: 1 },
      '/repo/touched.ts': { size: 1, mtime: 2 },
      '/repo/gone.ts': 'missing',
      '/repo/back.ts': { size: 1, mtime: 3 }
    })

    expect(await collectEditorWatchCatchUpEvents(target, baseline)).toEqual([
      { kind: 'update', absolutePath: '/repo/grown.ts' },
      { kind: 'update', absolutePath: '/repo/touched.ts' },
      { kind: 'delete', absolutePath: '/repo/gone.ts' },
      { kind: 'create', absolutePath: '/repo/back.ts' }
    ])
  })

  it('stats one path per file and skips tabs outside this watch', async () => {
    stubOpenFiles([
      editTab('a.md'),
      editTab('a.md', { id: 'preview', mode: 'markdown-preview' }),
      editTab('other.ts', { worktreeId: 'wt-2' }),
      editTab('runtime.ts', { runtimeEnvironmentId: 'env-1' }),
      { ...editTab('outside.ts'), filePath: '/elsewhere/outside.ts' },
      editTab('picture.png', { mode: 'image' })
    ])
    stubDisk({ '/repo/a.md': { size: 1, mtime: 1 } })
    const baseline = await captureEditorWatchDiskBaseline(target)

    expect([...baseline.keys()]).toEqual(['/repo/a.md'])
    expect(statRuntimePath).toHaveBeenCalledOnce()
  })

  it('leaves files opened after the drop to their first fresh read', async () => {
    stubOpenFiles([])
    const baseline = await captureEditorWatchDiskBaseline(target)
    stubOpenFiles([editTab('new.ts')])
    stubDisk({ '/repo/new.ts': { size: 1, mtime: 1 } })

    expect(await collectEditorWatchCatchUpEvents(target, baseline)).toEqual([])
  })

  it('does not guess when the host cannot be reached, but reloads after an unreadable baseline', async () => {
    stubOpenFiles([editTab('a.ts'), editTab('b.ts')])
    stubDisk({ '/repo/a.ts': { size: 1, mtime: 1 }, '/repo/b.ts': 'offline' })
    const baseline = await captureEditorWatchDiskBaseline(target)
    stubDisk({ '/repo/a.ts': 'offline', '/repo/b.ts': { size: 1, mtime: 1 } })

    expect(await collectEditorWatchCatchUpEvents(target, baseline)).toEqual([
      { kind: 'update', absolutePath: '/repo/b.ts' }
    ])
  })

  it('stats an SSH worktree through its connection, not the local disk', async () => {
    const sshTarget = { ...target, connectionId: 'ssh-1' }
    stubOpenFiles([editTab('a.ts')])
    stubDisk({ '/repo/a.ts': { size: 1, mtime: 1 } })
    await captureEditorWatchDiskBaseline(sshTarget)

    expect(statRuntimePath).toHaveBeenCalledWith(
      { settings: null, worktreeId: 'wt-1', worktreePath: '/repo', connectionId: 'ssh-1' },
      '/repo/a.ts'
    )
  })

  it('stats a runtime-owned worktree through its runtime environment', async () => {
    const runtimeTarget = { ...target, runtimeEnvironmentId: 'env-1' }
    stubOpenFiles([editTab('a.ts', { runtimeEnvironmentId: 'env-1' })])
    stubDisk({ '/repo/a.ts': { size: 1, mtime: 1 } })
    await captureEditorWatchDiskBaseline(runtimeTarget)

    expect(statRuntimePath).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined
      },
      '/repo/a.ts'
    )
  })
})

describe('autosave hold during catch-up', () => {
  it('suspends autosave only on stamped, savable tabs it does not already gate', () => {
    stubOpenFiles([
      editTab('a.ts'),
      editTab('a.md', { id: 'preview', mode: 'markdown-preview' }),
      editTab('moving.ts', { pendingLiveDiskVerification: true }),
      editTab('new.ts')
    ])
    const baseline = new Map([
      ['/repo/a.ts', '1:1'],
      ['/repo/a.md', '1:1'],
      ['/repo/moving.ts', '1:1']
    ])
    const setPending = store.state.setPendingLiveDiskVerification
    setPending.mockClear()

    const release = holdEditorAutosaveDuringCatchUp(target, baseline)
    expect(setPending.mock.calls).toEqual([['/repo/a.ts', true]])
    release()
    expect(setPending.mock.calls).toEqual([
      ['/repo/a.ts', true],
      ['/repo/a.ts', false]
    ])
  })
})

describe('editor watch catch-up through the live event path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function replayMissedChange(
    file: Record<string, unknown>,
    after: DiskEntry
  ): Promise<void> {
    stubOpenFiles([file])
    stubDisk({ [String(file.filePath)]: { size: 1, mtime: 1 } })
    const baseline = await captureEditorWatchDiskBaseline(target)
    stubDisk({ [String(file.filePath)]: after })
    const events = await collectEditorWatchCatchUpEvents(target, baseline)
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(() => target)
    handleFsChanged({ worktreePath: '/repo', events }, null)
    vi.advanceTimersByTime(200)
    dispose()
  }

  it('reloads a clean tab whose file changed', async () => {
    await replayMissedChange(editTab('a.ts'), { size: 2, mtime: 2 })

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', relativePath: 'a.ts' })
    )
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('marks a dirty tab changed-on-disk and keeps its draft', async () => {
    await replayMissedChange(editTab('a.ts', { isDirty: true }), { size: 2, mtime: 2 })

    expect(setExternalMutation).toHaveBeenCalledWith('/repo/a.ts', 'changed')
    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
  })

  it('tombstones a tab whose file was deleted', async () => {
    await replayMissedChange(editTab('a.ts'), 'missing')

    expect(setExternalMutation).toHaveBeenCalledWith('/repo/a.ts', 'deleted')
  })

  it('does nothing for an unchanged file', async () => {
    await replayMissedChange(editTab('a.ts', { isDirty: true }), { size: 1, mtime: 1 })

    expect(setExternalMutation).not.toHaveBeenCalled()
    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
  })
})
