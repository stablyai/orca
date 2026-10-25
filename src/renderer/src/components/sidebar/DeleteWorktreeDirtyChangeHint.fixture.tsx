import { defineFixture } from '../../component-fixtures/component-fixture'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import type { DeleteWorktreeDirtyChangePreview } from './delete-worktree-dirty-change-counts'

const preview: DeleteWorktreeDirtyChangePreview = {
  files: [
    {
      path: 'src/renderer/src/components/sidebar/WorktreeCard.tsx',
      status: 'modified',
      hasUnresolvedConflict: false
    },
    {
      path: 'src/shared/worktree/git-identity-display.ts',
      status: 'modified',
      hasUnresolvedConflict: true
    },
    { path: 'docs/reference/component-fixtures.md', status: 'added', hasUnresolvedConflict: false },
    { path: 'scratch/notes.txt', status: 'untracked', hasUnresolvedConflict: false },
    { path: 'src/main/legacy-relay.ts', status: 'deleted', hasUnresolvedConflict: false }
  ],
  remainingPathCount: 12
}

// The hint sits under the workspace name inside the delete dialog's target list.
const ROW_WIDTH = 360

export const checking = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeDirtyChangeHint changeCount={undefined} checkState="checking" />
})

export const clean = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeDirtyChangeHint changeCount={undefined} checkState="complete" />
})

export const unavailable = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeDirtyChangeHint changeCount={undefined} checkState="unavailable" />
})

export const dirty = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeDirtyChangeHint changeCount={3} checkState="checking" />
})

export const dirtyWithPathsOpen = defineFixture({
  width: ROW_WIDTH,
  render: () => (
    <DeleteWorktreeDirtyChangeHint changeCount={17} checkState="complete" preview={preview} />
  ),
  interact: (frame) => {
    frame.querySelector('button')?.click()
  }
})
