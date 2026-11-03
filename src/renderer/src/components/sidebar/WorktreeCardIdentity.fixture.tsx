import { getDefaultSettings } from '../../../../shared/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from './WorktreeCard'

const repo = { ...makeRepo(), displayName: 'orca' }
const worktree = makeWorktree('identity-fixture', 'Primary workspace', {
  branch: 'main',
  isMainWorktree: true,
  isSparse: true,
  sparseDirectories: ['src/renderer']
})

export const primarySparse = defineFixture({
  width: 320,
  store: {
    settings: {
      ...getDefaultSettings('/home/fixture'),
      experimentalNewWorktreeCardStyle: true
    },
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    worktreeCardProperties: ['status', 'branch']
  },
  render: () => (
    <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <WorktreeCard
        worktree={worktree}
        repo={repo}
        isActive
        inPinnedSection
        nativeDragEnabled={false}
      />
    </div>
  )
})
