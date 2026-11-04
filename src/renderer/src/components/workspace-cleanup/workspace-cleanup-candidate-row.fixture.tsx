import { defineFixture } from '../../component-fixtures/component-fixture'
import { REPO_COLORS } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'
import { CandidateRow, type WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'

const NOW = 1_700_000_000_000
const LOCAL: ExecutionHostId = 'local'
const DEVBOX: ExecutionHostId = 'ssh:devbox'
const CLOUD: ExecutionHostId = 'runtime:cloud-env'

const NO_REVIEW: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}
const NO_CONTEXT: WorkspaceCleanupCandidate['localContext'] = {
  terminalTabCount: 0,
  cleanEditorTabCount: 0,
  browserTabCount: 0,
  diffCommentCount: 0,
  newestDiffCommentAt: null,
  retainedDoneAgentCount: 0
}
const GIT_CLEAN = { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
const GIT_UNKNOWN = { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }

// "unlisted" is deliberately absent: a repo the renderer has not loaded falls back to the default color.
const REPOS: Record<string, Pick<Repo, 'badgeColor' | 'repoIcon'>> = {
  orca: { badgeColor: REPO_COLORS[0] },
  halibut: { badgeColor: REPO_COLORS[2] },
  'sf-flyover': { badgeColor: REPO_COLORS[4] },
  notes: { badgeColor: REPO_COLORS[6] }
}

type Scenario = {
  candidate: WorkspaceCleanupCandidate
  activity: string
  size?: string | null
  review?: Partial<WorkspaceCleanupReviewInfo>
  status?: string | null
  deletionPhase?: WorkspaceCleanupDeletionPhase
  failure?: Omit<WorkspaceCleanupFailure, 'worktreeId' | 'displayName'>
  gitPending?: boolean
  selected?: boolean
  expanded?: boolean
}

function ws(
  name: string,
  repoName: string,
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: `${repoName}::/repo/${name}`,
    repoId: repoName,
    repoName,
    connectionId: null,
    executionHostId: LOCAL,
    displayName: name,
    branch: name,
    path: `/Users/me/code/${repoName}/${name}`,
    tier: 'review',
    selectedByDefault: false,
    reasons: [],
    blockers: [],
    lastActivityAt: NOW,
    localContext: NO_CONTEXT,
    git: GIT_CLEAN,
    fingerprint: name,
    ...overrides
  }
}

function Rows({
  scenarios,
  showHostLabel = false
}: {
  scenarios: Scenario[]
  showHostLabel?: boolean
}): React.JSX.Element {
  const noop = (): void => {}
  const showSizeColumn = scenarios.some((scenario) => scenario.size != null)
  return (
    <div>
      {scenarios.map((scenario, index) => {
        const { candidate } = scenario
        const identity = `${candidate.executionHostId}:${candidate.connectionId}:${candidate.worktreeId}`
        return (
          <CandidateRow
            key={identity}
            identity={identity}
            candidate={candidate}
            reviewInfo={{ ...NO_REVIEW, ...scenario.review }}
            repo={REPOS[candidate.repoName] ?? null}
            showHostLabel={showHostLabel}
            showSizeColumn={showSizeColumn}
            expanded={scenario.expanded ?? false}
            last={index === scenarios.length - 1}
            lastActivityLabel={scenario.activity}
            sizeLabel={scenario.size ?? null}
            workspaceStatusLabel={scenario.status ?? null}
            deletionPhase={scenario.deletionPhase}
            removing={scenario.deletionPhase !== undefined}
            failure={
              scenario.failure
                ? {
                    worktreeId: candidate.worktreeId,
                    displayName: candidate.displayName,
                    ...scenario.failure
                  }
                : undefined
            }
            gitEvidencePending={scenario.gitPending}
            selected={scenario.selected ?? false}
            onIgnore={noop}
            onRestore={noop}
            onRemove={noop}
            onForgetLocally={noop}
            onDeleteAnyway={noop}
            onToggleExpanded={noop}
            onToggleSelected={noop}
            onView={noop}
          />
        )
      })}
    </div>
  )
}

/** Mirrors the reported screenshot: one machine, sizes never scanned. */
const SINGLE_HOST: Scenario[] = [
  {
    candidate: ws('sf-flyover', 'sf-flyover', {
      blockers: ['dismissed', 'dirty-files'],
      git: { ...GIT_CLEAN, clean: false }
    }),
    activity: '4d ago'
  },
  {
    candidate: ws('main', 'sf-flyover', {
      blockers: ['main-worktree'],
      git: GIT_UNKNOWN,
      localContext: { ...NO_CONTEXT, terminalTabCount: 1 }
    }),
    activity: '26h ago',
    status: 'In progress'
  },
  {
    candidate: ws('halibut', 'halibut', {
      blockers: ['unpushed-commits'],
      git: { ...GIT_CLEAN, upstreamAhead: 2 }
    }),
    activity: '26h ago',
    status: 'In progress',
    selected: true
  },
  {
    candidate: ws('main', 'halibut', { blockers: ['main-worktree'], git: GIT_UNKNOWN }),
    activity: '18m ago',
    status: 'In progress'
  },
  {
    candidate: ws('main', 'orca', {
      blockers: ['main-worktree', 'active-workspace', 'running-terminal'],
      git: GIT_UNKNOWN,
      localContext: { ...NO_CONTEXT, terminalTabCount: 2 }
    }),
    activity: 'Just now',
    status: 'In progress'
  }
]

/** Same names across machines: the host label appears and tells them apart. */
const MULTI_HOST: Scenario[] = [
  {
    candidate: ws('main', 'orca', { blockers: ['main-worktree'] }),
    activity: '2h ago',
    size: '4.8 GB'
  },
  {
    candidate: ws('main', 'orca', { executionHostId: DEVBOX, blockers: ['main-worktree'] }),
    activity: '3d ago',
    size: '5.1 GB'
  },
  {
    candidate: ws('fix-login', 'orca', { executionHostId: DEVBOX }),
    activity: '40d ago',
    size: '88 MB',
    review: { hasReview: true, label: 'PR #812', state: 'merged', provider: 'github' }
  },
  {
    candidate: ws('fix-login', 'orca', { executionHostId: CLOUD }),
    activity: '12d ago'
  },
  {
    candidate: ws('spike', 'halibut', {
      executionHostId: undefined,
      connectionId: 'old-laptop',
      blockers: ['ssh-disconnected'],
      git: GIT_UNKNOWN
    }),
    activity: '61d ago'
  }
]

/** Transient and failure states during or after deletion. */
const STATES: Scenario[] = [
  { candidate: ws('old-ui', 'orca'), activity: '30d ago', deletionPhase: 'deleting' },
  { candidate: ws('old-api', 'orca'), activity: '31d ago', deletionPhase: 'queued' },
  {
    candidate: ws('flaky', 'halibut', { git: GIT_UNKNOWN }),
    activity: '9d ago',
    failure: { message: 'Git status could not be verified.', canDeleteAnyway: true }
  },
  {
    candidate: ws('locked', 'halibut'),
    activity: '9d ago',
    failure: { message: 'Workspace is locked by another process.' }
  },
  { candidate: ws('checking', 'orca', { git: GIT_UNKNOWN }), activity: '2d ago', gitPending: true },
  {
    candidate: ws('mystery', 'orca', {
      executionHostId: undefined,
      blockers: ['git-status-error'],
      git: GIT_UNKNOWN
    }),
    activity: 'Never'
  }
]

/** Git, review, project, and naming variety. */
const VARIETY: Scenario[] = [
  {
    candidate: ws('feature/payments-v2', 'orca'),
    activity: '5d ago',
    size: '120 MB',
    review: { hasReview: true, label: 'PR #904', state: 'open', provider: 'github' }
  },
  {
    candidate: ws('draft-experiment', 'orca', { git: { ...GIT_CLEAN, clean: false } }),
    activity: '7d ago',
    size: '64 MB',
    review: { hasReview: true, label: 'PR #911', state: 'draft', provider: 'github' }
  },
  {
    candidate: ws('abandoned', 'halibut', { reasons: ['archived'] }),
    activity: '90d ago',
    size: '1.4 GB',
    review: { hasReview: true, label: 'MR !42', state: 'closed', provider: 'gitlab' }
  },
  {
    candidate: ws('notes', 'notes', { blockers: ['folder-repo'], git: GIT_UNKNOWN }),
    activity: '1d ago',
    size: '2 MB'
  },
  {
    candidate: ws('detached', 'unlisted'),
    activity: '14d ago',
    size: '18 MB',
    status: 'Blocked'
  },
  {
    candidate: ws(
      'a-really-long-workspace-name-that-will-not-fit-on-one-line',
      'an-equally-long-project-name'
    ),
    activity: '3d ago'
  }
]

const OVERFLOW_ROW: Scenario = {
  candidate: ws('main', 'orca', {
    worktreeId: 'orca::/repo/main#overflow',
    blockers: ['main-worktree', 'pinned', 'active-workspace', 'running-terminal', 'live-agent'],
    git: GIT_UNKNOWN,
    localContext: {
      ...NO_CONTEXT,
      terminalTabCount: 2,
      browserTabCount: 1,
      retainedDoneAgentCount: 1
    }
  }),
  activity: 'Just now',
  status: 'In progress'
}

export const singleHost = defineFixture({
  width: 880,
  render: () => <Rows scenarios={SINGLE_HOST} />
})

export const multiHost = defineFixture({
  width: 880,
  render: () => <Rows scenarios={MULTI_HOST} showHostLabel />
})

export const states = defineFixture({
  width: 880,
  render: () => <Rows scenarios={STATES} showHostLabel />
})

export const variety = defineFixture({
  width: 880,
  render: () => <Rows scenarios={VARIETY} />
})

export const overflow = defineFixture({
  width: 880,
  render: () => (
    <Rows
      scenarios={[
        OVERFLOW_ROW,
        {
          ...OVERFLOW_ROW,
          candidate: {
            ...OVERFLOW_ROW.candidate,
            worktreeId: 'halibut::/repo/main',
            repoId: 'halibut',
            repoName: 'halibut'
          },
          expanded: true
        }
      ]}
    />
  )
})

export const narrow = defineFixture({
  width: 560,
  render: () => <Rows scenarios={[...MULTI_HOST.slice(0, 3), OVERFLOW_ROW]} showHostLabel />
})

/** Keyboard focus reveals the same row actions hover does. */
export const focusedRow = defineFixture({
  width: 880,
  render: () => <Rows scenarios={VARIETY.slice(0, 3)} />,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[aria-label^="Open draft-experiment"]')?.focus()
  }
})

export const expandedDetails = defineFixture({
  width: 880,
  render: () => (
    <Rows
      scenarios={[
        { ...SINGLE_HOST[2], selected: false, expanded: true },
        { ...SINGLE_HOST[1], expanded: true }
      ]}
    />
  )
})

/** An ignored row offers Stop ignoring in the slot Ignore used. */
export const ignoredFocused = defineFixture({
  width: 880,
  render: () => <Rows scenarios={SINGLE_HOST.slice(0, 1)} />,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[aria-label^="Stop ignoring"]')?.focus()
  }
})
