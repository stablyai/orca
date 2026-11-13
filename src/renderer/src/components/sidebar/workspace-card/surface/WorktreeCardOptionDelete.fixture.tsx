import { useEffect } from 'react'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from './WorktreeCard'

// OPTION-TRASH-CLOUD: the sidebar while Option is held, each card as if hovered. A cloud workspace's
// own row (created here, or paired from Home) shows the trash like a local worktree; a local repo's
// primary checkout still doesn't (Git can't delete it).
const repo = { ...makeRepo(), displayName: 'orca' }
const worktrees = [
  makeWorktree('local-main', 'orca', { isMainWorktree: true }),
  makeWorktree('local-wt', 'fix-login', { branch: 'refs/heads/fix-login' }),
  makeWorktree('cloud-owned', 'Add a push test', {
    isMainWorktree: true,
    hostId: 'runtime:env-owned',
    branch: 'refs/heads/add-push-test'
  }),
  makeWorktree('cloud-paired', 'Ada’s cloud workspace', {
    isMainWorktree: true,
    hostId: 'runtime:env-paired',
    branch: 'refs/heads/ada/onboarding'
  })
]

// The created workspace's sandbox server, and a workspace paired from Home.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cloud row check reads only id, name, source and orcaCloudPaired.
const CLOUD_SERVERS = [
  { id: 'env-owned', name: 'orca sandbox a1b2c3d4', source: 'ephemeral-vm' },
  { id: 'env-paired', name: 'orca (cloud)', orcaCloudPaired: true }
] as never

function HoldOption({ children }: { children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
  }, [])
  return <>{children}</>
}

export const optionHeld = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [repo],
    worktreesByRepo: { [repo.id]: worktrees },
    worktreeCardProperties: ['status', 'branch'],
    runtimeEnvironments: CLOUD_SERVERS
  },
  setup: () => seedCloudWorkspaceSnapshot({ ids: new Set(['cloud-owned']), idsLoaded: true }),
  render: () => (
    <HoldOption>
      {/* Every card as if hovered: the trash only shows on the card under the pointer. */}
      <style>
        {'[data-option-delete-fixture] button[aria-label="Delete workspace"]{opacity:1}'}
      </style>
      <div
        data-option-delete-fixture=""
        className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground"
      >
        {worktrees.map((worktree) => (
          <WorktreeCard
            key={worktree.id}
            worktree={worktree}
            repo={repo}
            isActive={false}
            nativeDragEnabled={false}
          />
        ))}
      </div>
    </HoldOption>
  )
})
