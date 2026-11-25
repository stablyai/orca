// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { remapOpenEditorTabsForPathChange } from './remap-open-editor-tabs-for-path-change'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import {
  editorMoveOwnerFromContext,
  type EditorMoveOwner
} from '@/lib/editor/file-operations/open-editor-move-owner'

// Switch on: main renames the tabs, and its frame rekeys the content (T1 transport, apply mode).
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

let main: TabsDrawnFromMain

/** The remap once every open is drawn, then main's answer and the frame that carries it. */
async function remap(
  args: Parameters<typeof remapOpenEditorTabsForPathChange>[0]
): Promise<ReturnType<typeof remapOpenEditorTabsForPathChange>> {
  await main.settle()
  const result = remapOpenEditorTabsForPathChange(args)
  await main.settle()
  return result
}

function localMoveOwner(worktreeId: string | undefined): EditorMoveOwner {
  return editorMoveOwnerFromContext({ target: { kind: 'local' } }, worktreeId)
}

describe('remapOpenEditorTabsForPathChange', () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    main = await drawTabsFromMain(useAppStore)
  })

  afterEach(() => main.close())

  it('moves only the renaming host’s editor of a same-id twin, with its draft and preview', async () => {
    const state = useAppStore.getState()
    const worktreeId = 'wt-1'
    const worktreePath = '/repo'
    const oldPath = '/repo/docs/readme.md'
    const newPath = '/repo/notes/readme.md'
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as NonNullable<
        ReturnType<typeof useAppStore.getState>['settings']
      >
    })

    state.openFile(
      {
        filePath: oldPath,
        relativePath: 'docs/readme.md',
        worktreeId,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const localEditId = useAppStore.getState().openFiles[0]?.id
    expect(localEditId).toBeTruthy()
    state.setEditorDraft(localEditId!, 'local draft')
    state.markFileDirty(localEditId!, true)

    state.openFile({
      filePath: oldPath,
      relativePath: 'docs/readme.md',
      worktreeId,
      runtimeEnvironmentId: 'env-remote',
      language: 'markdown',
      mode: 'edit'
    })
    const remoteEdit = useAppStore
      .getState()
      .openFiles.find((file) => file.mode === 'edit' && file.runtimeEnvironmentId === 'env-remote')
    expect(remoteEdit).toBeTruthy()
    state.setEditorDraft(remoteEdit!.id, 'remote draft')
    state.markFileDirty(remoteEdit!.id, true)

    state.openMarkdownPreview(
      {
        filePath: oldPath,
        relativePath: 'docs/readme.md',
        worktreeId,
        runtimeEnvironmentId: 'env-remote',
        language: 'markdown'
      },
      { anchor: 'heading', sourceFileId: remoteEdit!.id }
    )

    await remap({
      fromPath: '/repo/docs',
      toPath: '/repo/notes',
      worktreePath,
      worktreeId,
      owner: editorMoveOwnerFromContext(
        {
          target: { kind: 'environment', environmentId: 'env-remote' },
          expectedExecutionHostId: 'local'
        },
        worktreeId
      )
    })

    const nextState = useAppStore.getState()
    const remoteRemapped = nextState.openFiles.find(
      (file) =>
        file.filePath === newPath &&
        file.mode === 'edit' &&
        file.runtimeEnvironmentId === 'env-remote'
    )
    expect(remoteRemapped).toMatchObject({ relativePath: 'notes/readme.md', isDirty: true })
    expect(nextState.editorDrafts[remoteRemapped!.id]).toBe('remote draft')
    expect(nextState.editorDrafts[remoteEdit!.id]).toBeUndefined()
    expect(
      nextState.openFiles.find(
        (file) => file.mode === 'markdown-preview' && file.runtimeEnvironmentId === 'env-remote'
      )
    ).toMatchObject({
      filePath: newPath,
      relativePath: 'notes/readme.md',
      markdownPreviewAnchor: 'heading',
      markdownPreviewSourceFileId: remoteRemapped!.id
    })
    // The local twin's file never moved, so its tab and unsaved draft stay where they were.
    const local = nextState.openFiles.find((file) => file.id === localEditId)
    expect(local).toMatchObject({ filePath: oldPath, isDirty: true, runtimeEnvironmentId: null })
    expect(nextState.editorDrafts[localEditId!]).toBe('local draft')
  })

  it('leaves a same-path tab on a different execution host untouched', async () => {
    // Same paths on distinct SSH owners are different files; connA rename must preserve connB drafts/tabs.
    const state = useAppStore.getState()
    useAppStore.setState({
      repos: [
        { id: 'repoA', connectionId: 'connA' },
        { id: 'repoB', connectionId: 'connB' }
      ] as never,
      worktreesByRepo: {
        repoA: [{ id: 'wt-a', repoId: 'repoA' }],
        repoB: [{ id: 'wt-b', repoId: 'repoB' }]
      } as never
    })

    const openDirtyAt = (worktreeId: string, draft: string): string => {
      state.openFile(
        {
          filePath: '/repo/a.md',
          relativePath: 'a.md',
          worktreeId,
          runtimeEnvironmentId: null,
          language: 'markdown',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
      const id = useAppStore.getState().openFiles.find((f) => f.worktreeId === worktreeId)!.id
      state.setEditorDraft(id, draft)
      state.markFileDirty(id, true)
      return id
    }
    openDirtyAt('wt-a', 'draft A')
    const idB = openDirtyAt('wt-b', 'draft B')

    const result = await remap({
      fromPath: '/repo/a.md',
      toPath: '/repo/b.md',
      worktreePath: '/repo',
      worktreeId: 'wt-a',
      owner: localMoveOwner('wt-a')
    })
    expect(result.ok).toBe(true)

    const files = useAppStore.getState().openFiles
    expect(files.find((f) => f.worktreeId === 'wt-a')!.filePath).toBe('/repo/b.md')
    const tabB = files.find((f) => f.worktreeId === 'wt-b')!
    expect(tabB.id).toBe(idB)
    expect(tabB.filePath).toBe('/repo/a.md')
    expect(tabB.isDirty).toBe(true)
    expect(useAppStore.getState().editorDrafts[idB]).toBe('draft B')
  })

  it('rebuilds the moved path across WSL UNC aliases without fabricating segments', async () => {
    // WSL UNC aliases match despite different lengths; reconstruct by segments, never raw fromPath.length slices.
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '\\\\wsl.localhost\\ubuntu\\repo\\src\\a.ts',
        relativePath: 'src\\a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const id = useAppStore.getState().openFiles[0]!.id
    state.setEditorDraft(id, 'wsl draft')
    state.markFileDirty(id, true)

    const result = await remap({
      fromPath: '\\\\wsl$\\Ubuntu\\repo\\src',
      toPath: '\\\\wsl$\\Ubuntu\\repo\\dst',
      worktreePath: '\\\\wsl$\\Ubuntu\\repo',
      worktreeId: 'wt-1',
      owner: localMoveOwner('wt-1')
    })

    expect(result.ok).toBe(true)
    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.filePath).toBe('\\\\wsl$\\Ubuntu\\repo\\dst\\a.ts')
    expect(useAppStore.getState().editorDrafts[moved.id]).toBe('wsl draft')
  })

  it('preserves a legal backslash in a POSIX/SSH filename (no separator invention)', async () => {
    // POSIX backslashes are filename data, never separators in either source or destination.
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo/src/a\\b.txt',
        relativePath: 'src/a\\b.txt',
        worktreeId: 'wt-1',
        language: 'plaintext',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    await remap({
      fromPath: '/repo/src',
      toPath: '/repo/dst',
      worktreePath: '/repo',
      worktreeId: 'wt-1',
      owner: localMoveOwner('wt-1')
    })

    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('/repo/dst/a\\b.txt')
  })
})
