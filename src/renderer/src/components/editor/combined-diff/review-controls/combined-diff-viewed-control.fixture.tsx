import { useState } from 'react'
import { defineFixture } from '@/component-fixtures/component-fixture'
import {
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { getReviewedDiffs, setDiffReviewed } from '@/lib/editor/diff-reviewed-files'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { DiffSectionHeader } from '../../diff/sections/DiffSectionHeader'
import { CombinedDiffViewedControl } from './combined-diff-viewed-control'

const file: OpenFile = {
  id: 'combined-review-fixture',
  worktreeId: 'wt-review',
  filePath: '/repo',
  relativePath: 'Changes',
  mode: 'diff',
  diffSource: 'combined-uncommitted',
  runtimeEnvironmentId: null,
  language: 'plaintext',
  isDirty: false
}
function ReviewHeader(): React.JSX.Element {
  const [sections, setSections] = useState<DiffSection[]>([
    {
      key: 'unstaged:src/review-state.ts',
      path: 'src/review-state.ts',
      status: 'modified',
      area: 'unstaged',
      added: 1,
      removed: 1,
      originalContent: 'before',
      modifiedContent: 'after',
      collapsed: false,
      loading: false,
      dirty: false,
      reviewModifiedTime: 123,
      largeDiffRenderLimit: null,
      diffResult: {
        kind: 'text',
        originalContent: 'before',
        modifiedContent: 'after',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    }
  ])
  const section = sections[0]!
  return (
    <DiffSectionHeader
      path={section.path}
      dirty={section.dirty}
      collapsed={section.collapsed}
      added={1}
      removed={1}
      onToggle={() => setSections(([current]) => [{ ...current!, collapsed: !current!.collapsed }])}
      onOpenSection={() => {}}
      openSectionTitle="Open diff"
      trailingContent={
        <CombinedDiffViewedControl file={file} section={section} setSections={setSections} />
      }
    />
  )
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
  render: () => <ReviewHeader />
}
export const unviewed = defineFixture(fixture)
export const viewed = defineFixture({
  ...fixture,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[role=checkbox]')?.click()
  }
})
export const narrow = defineFixture({ ...fixture, width: 280 })
