import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../surface/WorktreeCard'

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

const imageRepo = {
  ...makeRepo(),
  id: 'repo-image',
  displayName: 'orca-app',
  repoIcon: {
    type: 'image' as const,
    source: 'upload' as const,
    src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="%2309090b"/><circle cx="12" cy="12" r="9" fill="none" stroke="%23ffffff" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="%23ffffff"/><circle cx="9.5" cy="9.5" r="2" fill="%2309090b"/></svg>'
  }
}

const pinnedWorktree = makeWorktree('pinned-classic', 'orca worktree space', {
  repoId: imageRepo.id,
  branch: 'nwparker/tracked-source-clone-benchmark',
  isPinned: true
})

const statusGroupWorktree = makeWorktree('status-classic', 'Bot Header UX', {
  repoId: imageRepo.id,
  branch: 'nwparker/Bot-Header-UX'
})

const statusGroupLettersWorktree = makeWorktree('status-letters', 'API rate limiting', {
  repoId: repo.id,
  branch: 'nwparker/api-rate-limiting'
})

export const classicRepoBadgePlacement = defineFixture({
  width: 340,
  store: {
    settings: {
      ...getDefaultSettings('/home/fixture'),
      experimentalNewWorktreeCardStyle: false
    },
    repos: [imageRepo, repo],
    worktreesByRepo: {
      [imageRepo.id]: [pinnedWorktree, statusGroupWorktree],
      [repo.id]: [statusGroupLettersWorktree]
    },
    worktreeCardProperties: ['status', 'branch']
  },
  render: () => (
    <div className="flex flex-col gap-2 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <div className="px-2 text-xs font-semibold text-muted-foreground">Pinned</div>
      <WorktreeCard
        worktree={pinnedWorktree}
        repo={imageRepo}
        isActive={false}
        inPinnedSection
        nativeDragEnabled={false}
      />
      <div className="px-2 pt-1 text-xs font-semibold text-muted-foreground">In progress</div>
      <WorktreeCard
        worktree={statusGroupWorktree}
        repo={imageRepo}
        isActive={false}
        nativeDragEnabled={false}
      />
      <WorktreeCard
        worktree={statusGroupLettersWorktree}
        repo={repo}
        isActive={false}
        nativeDragEnabled={false}
      />
    </div>
  )
})
