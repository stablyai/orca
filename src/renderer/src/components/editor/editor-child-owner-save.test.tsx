// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'
import type { FileContent } from './editor-panel-content-types'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import type { readEditorCsvFileContent } from './csv/csv-file-content'
import type { writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

const io = vi.hoisted(() => ({
  read: vi.fn<typeof readEditorCsvFileContent>(),
  write: vi.fn<typeof writeRuntimeFile>()
}))
vi.mock('./csv/csv-file-content', () => ({ readEditorCsvFileContent: io.read }))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({ writeRuntimeFile: io.write }))

const workspaceId = 'folder:mixed'
const filePath = '/root/local/file.ts'
let queue: EditorSaveQueue

beforeEach(() => {
  io.read.mockReset().mockResolvedValue({ content: 'disk content', isBinary: false })
  io.write.mockReset().mockResolvedValue({ ok: true })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), editorAutoSave: true, editorAutoSaveDelayMs: 250 },
    folderWorkspaces: [makeFolderWorkspace({ id: 'mixed', folderPath: '/root' })],
    projectGroups: [makeProjectGroup()],
    repos: [
      {
        ...TEST_REPO,
        id: 'child',
        path: '/root/local',
        projectGroupId: 'group-1',
        executionHostId: 'local'
      },
      {
        ...TEST_REPO,
        id: 'remote',
        path: '/root/remote',
        projectGroupId: 'group-1',
        executionHostId: 'ssh:box',
        connectionId: 'box'
      }
    ]
  })
  queue = createEditorSaveQueue(useAppStore)
})

afterEach(() => {
  queue.dispose()
  cleanup()
})

async function loadChild() {
  const id = useAppStore.getState().openFile(
    {
      worktreeId: workspaceId,
      filePath,
      relativePath: 'local/file.ts',
      mode: 'edit',
      language: 'typescript',
      runtimeEnvironmentId: null
    },
    { suppressActiveRuntimeFallback: true }
  )
  let contents: Record<string, FileContent> = {}
  const { result } = renderHook(() =>
    useEditorPanelFileContentLoader({
      fileLoadRetryAttemptsRef: { current: {} },
      fileReadGenerationCounterRef: { current: 0 },
      fileReadGenerationRef: { current: {} },
      outstandingFileReadsRef: { current: {} },
      openFilesRef: {
        get current() {
          return useAppStore.getState().openFiles
        }
      },
      setFileContents: (update) => {
        contents = typeof update === 'function' ? update(contents) : update
      }
    })
  )
  await act(async () => {
    await result.current(filePath, id, workspaceId, 'local/file.ts')
  })
  expect(contents[id]).toMatchObject({ content: 'disk content', isBinary: false })
  expect(live(id).lastKnownDiskSignature).toBe(getDiskBaselineSignature('disk content'))
  expect(live(id).operationProvenance).toMatchObject({
    childRepo: { id: 'child', path: '/root/local' }
  })
  return id
}

function live(id: string) {
  const file = useAppStore.getState().openFiles.find((file) => file.id === id)
  if (!file) {
    throw new Error('Missing loaded tab')
  }
  return file
}

function edit(id: string, draft: string) {
  useAppStore.getState().setEditorDraft(id, draft)
  useAppStore.getState().markFileDirty(id, true)
}

describe('loaded child-file save ownership', () => {
  it('autosaves then drains a queued restart to the acquired child after unrelated sibling removal', async () => {
    const id = await loadChild()
    let finish!: (result: FileWriteResult) => void
    io.write.mockReturnValueOnce(
      new Promise<FileWriteResult>((resolve) => {
        finish = resolve
      })
    )
    edit(id, 'autosave text')
    queue.syncAutoSave()
    await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce())
    edit(id, 'restart text')
    const pending = queue.queueSave(live(id), 'restart text', 'restart')
    useAppStore.setState((state) => ({ repos: state.repos.filter((repo) => repo.id !== 'remote') }))
    finish({ ok: true })
    await expect(pending).resolves.toBe('written')
    expect(io.write).toHaveBeenCalledTimes(2)
    for (const [context, path] of io.write.mock.calls) {
      expect(context).toMatchObject({ target: { kind: 'local' }, expectedExecutionHostId: 'local' })
      expect(context.connectionId).toBeUndefined()
      expect(path).toBe(filePath)
    }
    expect(io.write.mock.calls.map((call) => call[2])).toEqual(['autosave text', 'restart text'])
    expect(live(id).isDirty).toBe(false)
  })

  it.each(['replaced', 'removed', 'authority'] as const)(
    'refuses a queued restart after the child is %s and retains its draft',
    async (change) => {
      const id = await loadChild()
      const stamp = live(id).operationProvenance
      let finish!: (result: FileWriteResult) => void
      io.write.mockReturnValueOnce(
        new Promise<FileWriteResult>((resolve) => {
          finish = resolve
        })
      )
      edit(id, 'first text')
      const first = queue.queueSave(live(id), 'first text')
      await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce())
      edit(id, 'retained draft')
      const restart = queue.queueSave(live(id), 'retained draft', 'restart')
      useAppStore.setState((state) => ({
        repos: state.repos.flatMap((repo) =>
          repo.id !== 'child'
            ? [repo]
            : change === 'removed'
              ? []
              : [
                  {
                    ...repo,
                    ...(change === 'replaced'
                      ? { id: 'replacement' }
                      : { executionHostId: 'ssh:other' as const, connectionId: 'other' })
                  }
                ]
        )
      }))
      finish({ ok: true })
      await first
      await expect(restart).resolves.toBe('failed')
      expect(io.write).toHaveBeenCalledOnce()
      expect(live(id).operationProvenance).toBe(stamp)
      expect(useAppStore.getState().editorDrafts[id]).toBe('retained draft')
      expect(live(id).isDirty).toBe(true)
    }
  )
})
