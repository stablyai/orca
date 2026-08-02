import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { remapOpenEditorTabsForPathChange } from './remap-open-editor-tabs-for-path-change'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

describe('remapOpenEditorTabsForPathChange', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('preserves runtime owners, drafts, dirty state, and markdown preview sources', () => {
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

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/docs',
      toPath: '/repo/notes',
      worktreePath,
      worktreeId
    })

    const nextState = useAppStore.getState()
    expect(nextState.openFiles.some((file) => file.filePath === oldPath)).toBe(false)

    const localRemapped = nextState.openFiles.find(
      (file) =>
        file.filePath === newPath && file.mode === 'edit' && file.runtimeEnvironmentId === null
    )
    const remoteRemapped = nextState.openFiles.find(
      (file) =>
        file.filePath === newPath &&
        file.mode === 'edit' &&
        file.runtimeEnvironmentId === 'env-remote'
    )
    expect(localRemapped).toMatchObject({
      relativePath: 'notes/readme.md',
      isDirty: true,
      runtimeEnvironmentId: null
    })
    expect(remoteRemapped).toMatchObject({
      relativePath: 'notes/readme.md',
      isDirty: true,
      runtimeEnvironmentId: 'env-remote'
    })
    expect(nextState.editorDrafts[localRemapped!.id]).toBe('local draft')
    expect(nextState.editorDrafts[remoteRemapped!.id]).toBe('remote draft')
    expect(nextState.editorDrafts[localEditId!]).toBeUndefined()
    expect(nextState.editorDrafts[remoteEdit!.id]).toBeUndefined()

    const remotePreview = nextState.openFiles.find(
      (file) => file.mode === 'markdown-preview' && file.runtimeEnvironmentId === 'env-remote'
    )
    expect(remotePreview).toMatchObject({
      filePath: newPath,
      relativePath: 'notes/readme.md',
      markdownPreviewAnchor: 'heading',
      markdownPreviewSourceFileId: remoteRemapped!.id
    })
  })

  it('retargets preview-only markdown source ids to the moved owner path', () => {
    const state = useAppStore.getState()
    const worktreePath = '/repo'
    const oldPath = '/repo/docs/readme.md'
    const newPath = '/repo/notes/readme.md'
    const floatingOldSourceId = ownedEditorFileId(oldPath, FLOATING_TERMINAL_WORKTREE_ID, null)
    const floatingNewSourceId = ownedEditorFileId(newPath, FLOATING_TERMINAL_WORKTREE_ID, null)

    state.openMarkdownPreview({
      filePath: oldPath,
      relativePath: 'docs/readme.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    state.openMarkdownPreview({
      filePath: oldPath,
      relativePath: 'readme.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })
    expect(
      useAppStore
        .getState()
        .openFiles.find((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
        ?.markdownPreviewSourceFileId
    ).toBe(floatingOldSourceId)

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/docs',
      toPath: '/repo/notes',
      worktreePath,
      worktreeId: 'wt-1'
    })

    const floatingPreview = useAppStore
      .getState()
      .openFiles.find((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)

    expect(floatingPreview).toMatchObject({
      id: `markdown-preview::${floatingNewSourceId}`,
      filePath: newPath,
      relativePath: '../notes/readme.md',
      markdownPreviewSourceFileId: floatingNewSourceId
    })
  })

  it('leaves a same-path tab on a different execution host untouched', () => {
    // Two SSH connections both have /repo/a.md open with separate dirty drafts.
    // Renaming on connA's host must not retarget connB's tab (a distinct file).
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

    const result = remapOpenEditorTabsForPathChange({
      fromPath: '/repo/a.md',
      toPath: '/repo/b.md',
      worktreePath: '/repo',
      worktreeId: 'wt-a'
    })
    expect(result.ok).toBe(true)

    const files = useAppStore.getState().openFiles
    // connA's tab moved; connB's tab kept its id, path, AND its dirty draft.
    expect(files.find((f) => f.worktreeId === 'wt-a')!.filePath).toBe('/repo/b.md')
    const tabB = files.find((f) => f.worktreeId === 'wt-b')!
    expect(tabB.id).toBe(idB)
    expect(tabB.filePath).toBe('/repo/a.md')
    expect(tabB.isDirty).toBe(true)
    expect(useAppStore.getState().editorDrafts[idB]).toBe('draft B')
  })

  it('selects a Windows tab whose path differs only in case from the move root', () => {
    // Windows paths are case-insensitive: an open tab at C:\Repo\Src\a.ts must be
    // retargeted when the move root is c:\repo\src — otherwise the rename lands on
    // disk while the tab is stranded on the vanished source path.
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: 'C:\\Repo\\Src\\a.ts',
        relativePath: 'Src\\a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const id = useAppStore.getState().openFiles[0]!.id
    state.setEditorDraft(id, 'dirty windows work')
    state.markFileDirty(id, true)

    const result = remapOpenEditorTabsForPathChange({
      fromPath: 'c:\\repo\\src',
      toPath: 'c:\\repo\\dst',
      worktreePath: 'c:\\repo',
      worktreeId: 'wt-1'
    })

    expect(result.ok).toBe(true)
    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.filePath).toBe('c:\\repo\\dst\\a.ts')
    expect(moved.isDirty).toBe(true)
    expect(useAppStore.getState().editorDrafts[moved.id]).toBe('dirty windows work')
  })

  it('rebuilds the moved path across WSL UNC aliases without fabricating segments', () => {
    // The shared matcher equates \\wsl$\Ubuntu and \\wsl.localhost\ubuntu (same
    // filesystem), but they differ in raw length — a raw slice(fromPath.length)
    // would corrupt the destination. Segment-count reconstruction must not.
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

    const result = remapOpenEditorTabsForPathChange({
      fromPath: '\\\\wsl$\\Ubuntu\\repo\\src',
      toPath: '\\\\wsl$\\Ubuntu\\repo\\dst',
      worktreePath: '\\\\wsl$\\Ubuntu\\repo',
      worktreeId: 'wt-1'
    })

    expect(result.ok).toBe(true)
    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.filePath).toBe('\\\\wsl$\\Ubuntu\\repo\\dst\\a.ts')
    expect(useAppStore.getState().editorDrafts[moved.id]).toBe('wsl draft')
  })

  it('preserves a legal backslash in a POSIX/SSH filename (no separator invention)', () => {
    // Backslash is legal filename data on POSIX; the move must not treat it as a
    // separator or emit one into the destination.
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

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/src',
      toPath: '/repo/dst',
      worktreePath: '/repo',
      worktreeId: 'wt-1'
    })

    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('/repo/dst/a\\b.txt')
  })

  it('preserves a legal POSIX backslash in a cross-worktree tab relative path', () => {
    const state = useAppStore.getState()
    // Anchor the move to wt-1 / local host.
    state.openFile(
      {
        filePath: '/repo/src/keep.ts',
        relativePath: 'src/keep.ts',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    // Floating tab for a POSIX file whose name contains a literal backslash.
    state.openFile(
      {
        filePath: '/repo/src/a\\b.txt',
        relativePath: 'a\\b.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'plaintext',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/src',
      toPath: '/repo/dst',
      worktreePath: '/repo',
      worktreeId: 'wt-1'
    })

    const floating = useAppStore
      .getState()
      .openFiles.find((f) => f.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)!
    expect(floating.filePath).toBe('/repo/dst/a\\b.txt')
    // The backslash stays filename data in the recomputed relativePath — it must
    // NOT have been folded into a `a/b.txt` separator.
    expect(floating.relativePath.includes('a\\b.txt')).toBe(true)
    expect(floating.relativePath.includes('a/b.txt')).toBe(false)
  })

  it('does not strip a trailing backslash from a POSIX destination directory name', () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    // Destination directory is literally named `dst\` (legal on POSIX).
    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/src',
      toPath: '/repo/dst\\',
      worktreePath: '/repo',
      worktreeId: 'wt-1'
    })

    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('/repo/dst\\/a.ts')
  })

  it('keeps `/` for a POSIX destination whose ancestor contains a legal backslash', () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/srv/team\\repo/src/a.ts',
        relativePath: 'src/a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    remapOpenEditorTabsForPathChange({
      fromPath: '/srv/team\\repo/src',
      toPath: '/srv/team\\repo/dst',
      worktreePath: '/srv/team\\repo',
      worktreeId: 'wt-1'
    })

    // POSIX flavor: the separator stays `/`; the ancestor backslash is untouched.
    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('/srv/team\\repo/dst/a.ts')
  })

  it('rebuilds the moved path when the source root has duplicate separators', () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: 'C:\\Repo\\Src\\deep\\a.ts',
        relativePath: 'Src\\deep\\a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    remapOpenEditorTabsForPathChange({
      fromPath: 'C:\\Repo\\\\Src',
      toPath: 'C:\\Repo\\Dst',
      worktreePath: 'C:\\Repo',
      worktreeId: 'wt-1'
    })

    // Nested suffix preserved, no dropped or doubled separator.
    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('C:\\Repo\\Dst\\deep\\a.ts')
  })

  it('clears the untitled marker when remapping a renamed new markdown file', () => {
    const state = useAppStore.getState()
    const oldPath = '/repo/untitled.md'
    const newPath = '/repo/renamed.md'

    state.openFile({
      filePath: oldPath,
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    remapOpenEditorTabsForPathChange({
      fromPath: oldPath,
      toPath: newPath,
      worktreePath: '/repo',
      worktreeId: 'wt-1'
    })

    expect(useAppStore.getState().openFiles).toHaveLength(1)
    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      filePath: newPath,
      relativePath: 'renamed.md'
    })
    expect(useAppStore.getState().openFiles[0].isUntitled).toBeUndefined()
  })

  it('carries the disk baseline and live conflict state onto the re-homed tab', () => {
    const state = useAppStore.getState()
    const oldPath = '/repo/notes.md'
    const newPath = '/repo/archive/notes.md'
    state.openFile(
      {
        filePath: oldPath,
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const oldId = useAppStore.getState().openFiles[0]!.id
    state.setEditorDraft(oldId, 'unsaved work')
    state.markFileDirty(oldId, true)
    state.setLastKnownDiskSignature(oldId, 'sig-abc')
    state.setExternalMutation(oldId, 'changed')

    remapOpenEditorTabsForPathChange({ fromPath: oldPath, toPath: newPath, worktreePath: '/repo' })

    const moved = useAppStore.getState().openFiles.find((f) => f.filePath === newPath)
    expect(moved).toBeTruthy()
    // The re-homed tab must keep the identity that lets the watcher distinguish
    // the move echo from a real external write, and any pre-existing conflict.
    expect(moved?.lastKnownDiskSignature).toBe('sig-abc')
    expect(moved?.externalMutation).toBe('changed')
    expect(moved?.isDirty).toBe(true)
  })

  it('retargets an unstaged diff tab when its directory is moved', () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo/docs/readme.md',
        relativePath: 'docs/readme.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      } as never,
      { suppressActiveRuntimeFallback: true }
    )

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo/docs',
      toPath: '/repo/notes',
      worktreePath: '/repo',
      worktreeId: 'wt-1'
    })

    const moved = useAppStore.getState().openFiles.find((f) => f.mode === 'diff')
    expect(moved?.filePath).toBe('/repo/notes/readme.md')
    expect(
      useAppStore.getState().openFiles.some((f) => f.filePath === '/repo/docs/readme.md')
    ).toBe(false)
  })
})
