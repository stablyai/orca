import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { editorFileHoldKey, pathMutationHoldKeys } from './editor-autosave-holds'

// A Windows desktop client: its own path rules must not fold a POSIX host's paths.
vi.mock('@/lib/desktop-window-chrome', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLocalWindowsDesktopClient: () => true
}))

function tab(id: string, filePath: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath,
    relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
    worktreeId: 'wt-other',
    language: 'typescript',
    isDirty: true,
    mode: 'edit',
    ...patch
  }
}

describe('discard hold keys on a Windows client', () => {
  const state = createEditorStore().getState()
  const remote = { runtimeEnvironmentId: 'env-1' }

  it('keeps a POSIX backslash file apart from the slash path', () => {
    const backslash = tab('a', '/repo/a\\b.ts', remote)
    const slash = tab('b', '/repo/a/b.ts', remote)
    // Both resolve to the remote host (not a per-tab fallback), yet stay distinct.
    expect([editorFileHoldKey(state, backslash), editorFileHoldKey(state, slash)]).not.toContain(
      'a'
    )
    expect(editorFileHoldKey(state, backslash)).not.toBe(editorFileHoldKey(state, slash))
    const discarded = pathMutationHoldKeys(state, {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'a/b.ts',
      ...remote
    })
    expect(discarded.has(editorFileHoldKey(state, slash))).toBe(true)
    expect(discarded.has(editorFileHoldKey(state, backslash))).toBe(false)
  })

  it('still matches one file across an edit tab and an unstaged diff tab', () => {
    const editTab = tab('a', '/repo/a/b.ts', remote)
    const diffTab = tab('b', '/repo/a/b.ts', { ...remote, mode: 'diff', diffSource: 'unstaged' })
    expect(editorFileHoldKey(state, editTab)).toBe(editorFileHoldKey(state, diffTab))
  })

  it('folds separators and drive case for a local Windows path', () => {
    const local = { worktreeId: 'wt-1' }
    const key = editorFileHoldKey(state, tab('a', 'C:\\repo\\a.ts', local))
    expect(key).not.toBe('a')
    expect(key).toBe(editorFileHoldKey(state, tab('b', 'c:/repo/a.ts', local)))
  })

  it('holds a `\\\\wsl.localhost` tab while its file is discarded via `\\\\wsl$`', () => {
    const local = { worktreeId: 'wt-1' }
    const tabKey = editorFileHoldKey(
      state,
      tab('b', '\\\\wsl.localhost\\ubuntu\\repo\\a.ts', local)
    )
    const discarded = pathMutationHoldKeys(state, {
      worktreeId: 'wt-1',
      worktreePath: '\\\\wsl$\\Ubuntu\\repo',
      relativePath: 'a.ts'
    })
    expect(tabKey).not.toBe('b')
    expect(discarded.has(tabKey)).toBe(true)
    // The Linux path keeps its case, and a real share named `wsl` is another machine.
    expect(
      discarded.has(editorFileHoldKey(state, tab('c', '\\\\wsl$\\Ubuntu\\repo\\A.ts', local)))
    ).toBe(false)
    expect(
      discarded.has(editorFileHoldKey(state, tab('d', '\\\\wsl\\Ubuntu\\repo\\a.ts', local)))
    ).toBe(false)
  })
})
