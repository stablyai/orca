import { expect, it, vi } from 'vitest'
import { openTabBarEntry } from './tab-create-entry-action'

const preview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-file-open', () => ({ openWorkspaceFile: preview }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: () => {
    throw new Error('A preview must not require file mutation authorization')
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ getKnownWorktreeById: () => ({ path: '/repo' }) })
  }
}))

it.each([true, false])(
  'opens an HTML preview without requiring file mutations (selected: %s)',
  async (selected) => {
    preview.mockClear()
    await openTabBarEntry({
      ...(selected
        ? { classification: { kind: 'html-file-url' as const, filePath: '/repo/report.html' } }
        : {}),
      query: 'file:///repo/report.html',
      worktreeId: 'remote',
      groupId: 'group-2',
      fileList: { files: [], loading: true, loadError: null }
    })
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith({
      kind: 'preview',
      filePath: '/repo/report.html',
      worktreeId: 'remote',
      targetGroupId: 'group-2'
    })
  }
)
