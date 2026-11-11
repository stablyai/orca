import { defineFixture } from '@/component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import {
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getReviewedDiffs, setDiffReviewed } from '@/lib/editor/diff-reviewed-files'
import { DiffViewedControl } from './diff-viewed-control'

const file: OpenFile = {
  id: 'review-fixture',
  worktreeId: 'wt-review',
  filePath: '/repo/src/review-state.ts',
  relativePath: 'src/review-state.ts',
  mode: 'diff',
  diffSource: 'unstaged',
  runtimeEnvironmentId: null,
  language: 'typescript',
  isDirty: false
}
const fixture = {
  width: 600,
  store: {
    activeWorktreeId: 'wt-review',
    activeFileId: file.id,
    openFiles: [file],
    repos: [{ ...makeRepo(), path: '/repo' }],
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-review', 'Review', { path: '/repo' })] }
  },
  setup: () => {
    for (const key of getReviewedDiffs().keys()) {
      setDiffReviewed(key, null)
    }
    window.api.fs.stat = async () => ({ mtime: 123, size: 5, isDirectory: false })
  },
  render: () => (
    <div className="editor-header">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">src/review-state.ts</span>
      <DiffViewedControl
        file={useAppStore.getState().openFiles[0]}
        content={{
          kind: 'text',
          originalContent: 'before',
          modifiedContent: 'after',
          originalIsBinary: false,
          modifiedIsBinary: false,
          reviewModifiedTime: 123
        }}
      />
    </div>
  )
}
export const unviewed = defineFixture(fixture)
export const viewed = defineFixture({
  ...fixture,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[role=checkbox]')?.click()
  }
})
export const narrow = defineFixture({ ...fixture, width: 280 })
