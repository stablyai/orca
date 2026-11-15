import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { FIXTURE_REPO, makeWorktree } from '../../worktree-card-slot-fixture-seeds'
import WorktreeCard from './WorktreeCard'

const now = Date.now()
const workspace: Worktree = {
  ...makeWorktree({ id: 'details-row', name: 'deploy-preview', agents: [] }, now),
  comment: 'Preview ready for review',
  cliProvenance: { kind: 'created-by-cli', createdAt: now },
  linkedItems: [
    {
      provider: 'github',
      type: 'issue',
      number: 123,
      url: 'https://github.com/stablyai/orca/issues/123'
    }
  ]
}

function fixture(detailsRow: boolean, indicators = true) {
  return defineFixture({
    width: 320,
    setup: () =>
      useAppStore.setState((state) => ({
        repos: [FIXTURE_REPO],
        worktreesByRepo: { [FIXTURE_REPO.id]: [workspace] },
        settings: state.settings
          ? {
              ...state.settings,
              experimentalNewWorktreeCardStyle: true,
              worktreeCardDetailsRow: detailsRow
            }
          : null,
        worktreeCardProperties: indicators
          ? ['status', 'branch', 'host', 'issue', 'comment', 'cli', 'ports']
          : ['status', 'branch'],
        workspacePortScan: {
          key: 'details-row',
          result: {
            platform: 'unknown',
            scannedAt: now,
            ports: [
              {
                kind: 'workspace',
                id: 'preview',
                bindHost: '127.0.0.1',
                connectHost: 'localhost',
                port: 3000,
                protocol: 'http',
                owner: {
                  worktreeId: workspace.id,
                  repoId: workspace.repoId,
                  displayName: workspace.displayName,
                  path: workspace.path,
                  confidence: 'cwd'
                }
              }
            ]
          }
        }
      })),
    render: () => (
      <WorktreeCard
        worktree={workspace}
        repo={FIXTURE_REPO}
        isActive={false}
        hideRepoBadge
        hostContextLabel="Build server"
        nativeDragEnabled={false}
      />
    )
  })
}

export const shown = fixture(true)
export const hidden = fixture(false)
export const displayOptionsOff = fixture(false, false)
export const hiddenWithConflict = defineFixture({
  ...fixture(false),
  store: { gitConflictOperationByWorktree: { [workspace.id]: 'cherry-pick' } }
})
