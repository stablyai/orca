import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import type { Worktree } from '../../../../../../shared/worktree/types'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import { toWorktreeDeleteIdentities } from './worktree-delete-request'

const parentRepo: Repo = {
  id: 'orca',
  path: '/projects/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const childRepo: Repo = {
  ...parentRepo,
  id: 'orca-cloud',
  path: '/projects/orca-cloud',
  displayName: 'orca-cloud'
}

const parent: Worktree = {
  id: 'orca::/workspaces/orca/enterprise-control-plane',
  instanceId: 'parent-instance',
  repoId: parentRepo.id,
  path: '/workspaces/orca/enterprise-control-plane',
  displayName: 'Enterprise Control Plane',
  head: 'abc123',
  branch: 'enterprise-control-plane',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

const childPaths = [
  'apps/console/next-env.d.ts',
  'cloud/packages/',
  'src/cli/',
  '.env.local',
  '.tmp/',
  'apps/console/.next/',
  'scratch/notes.md'
]

function reviewFixture(nested = false) {
  const childPath = nested ? `${parent.path}/Team-Policies` : '/workspaces/orca-cloud/Team-Policies'
  const child: Worktree = {
    ...parent,
    id: `${childRepo.id}::${childPath}`,
    instanceId: 'child-instance',
    repoId: childRepo.id,
    path: childPath,
    displayName: 'Team-Policies',
    branch: 'team-policies'
  }
  const identities = toWorktreeDeleteIdentities([parent, child])
  return defineFixture({
    width: 840,
    store: {
      repos: [parentRepo, childRepo],
      worktreesByRepo: { [parentRepo.id]: [parent], [childRepo.id]: [child] },
      worktreeLineageById: {
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
      },
      activeModal: 'delete-worktree',
      modalData: {
        worktreeId: parent.id,
        worktreeDeleteIdentities: toWorktreeDeleteIdentities([parent]),
        lineageDeleteIdentities: identities,
        lineagePreserveIdentities: identities
      }
    },
    setup: () => {
      window.api.git.status = async () => ({ entries: [], conflictOperation: 'unknown' })
      window.api.git.atRiskLocalFiles = async ({
        worktreePath
      }): Promise<WorktreeAtRiskLocalFiles> => {
        const paths = worktreePath === child.path ? childPaths : []
        return { count: paths.length, paths, samplePaths: paths.slice(0, 3), complete: true }
      }
    },
    render: () => (
      <div className="h-[520px] bg-background">
        <DeleteWorktreeDialog />
      </div>
    )
  })
}

export const splitReview = reviewFixture()
export const nestedChild = reviewFixture(true)
