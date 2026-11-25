import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import { DeleteWorktreeLocalFilesHint } from './DeleteWorktreeLocalFilesHint'

const ROW_WIDTH = 376

const atRiskFiles: WorktreeAtRiskLocalFiles = {
  count: 6,
  samplePaths: ['.env.local', '.anti-slop-plugin/', '.tmp/'],
  paths: [
    '.env.local',
    '.anti-slop-plugin/',
    '.tmp/',
    'scratch/migration-dump.sql',
    'tests/e2e/.cross-version-checkouts/',
    'packages/desktop/.orca-local/session-override.json'
  ],
  complete: true
}

export const checking = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeLocalFilesHint state={{ status: 'checking' }} />
})

export const clean = defineFixture({
  width: ROW_WIDTH,
  render: () => (
    <DeleteWorktreeLocalFilesHint
      state={{
        status: 'complete',
        files: { count: 0, samplePaths: [], paths: [], complete: true }
      }}
    />
  )
})

export const unsupported = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeLocalFilesHint state={{ status: 'unsupported' }} />
})

export const unchecked = defineFixture({
  width: ROW_WIDTH,
  render: () => (
    <DeleteWorktreeLocalFilesHint
      state={{
        status: 'complete',
        files: { count: 0, samplePaths: [], paths: [], complete: false }
      }}
    />
  )
})

export const atRisk = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeLocalFilesHint state={{ status: 'complete', files: atRiskFiles }} />
})

export const atRiskWithPathsOpen = defineFixture({
  width: ROW_WIDTH,
  render: () => <DeleteWorktreeLocalFilesHint state={{ status: 'complete', files: atRiskFiles }} />,
  interact: (frame) => {
    frame.querySelector('button')?.click()
  }
})
