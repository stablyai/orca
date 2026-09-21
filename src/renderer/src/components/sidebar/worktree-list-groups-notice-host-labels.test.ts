/**
 * A project checked out on several hosts emits one discovery-notice row per
 * checkout. Those rows only ever named the project, so a sidebar with paired
 * remote hosts showed identical "N hidden worktrees" buttons with no way to
 * tell which machine either belonged to.
 *
 * Two hosts can also share one user-facing label, which is when the rows are
 * hardest to tell apart — so the gate counts distinct host ids, and it reads
 * them from the unfiltered repo universe rather than the host-filtered notice
 * candidates, or a label would appear and disappear with the sidebar filter.
 */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getNoticeHostContextLabels } from './worktree-list/grouping/host-labels'
import { buildProjectGroupingIndex } from './worktree-list/grouping/project-grouping'
import { repo, worktree, project, projectHostSetups } from './worktree-list-groups-test-fixtures'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import type { Row } from './worktree-list/grouping/row-types'

const SSH_HOST_ID: ExecutionHostId = 'ssh:openclaw-target'
const ENV_HOST_ID: ExecutionHostId = 'runtime:openclaw-env'

/** Both twins display the same label: the reporting account's shape. */
const HOST_LABELS = new Map([
  ['local', 'Local Mac'],
  [SSH_HOST_ID, 'openclaw'],
  [ENV_HOST_ID, 'openclaw']
])

const sshTwin: Repo = {
  ...repo,
  id: 'repo-ssh-twin',
  path: '/home/brennan/orca',
  connectionId: 'openclaw-target'
}
const envTwin: Repo = {
  ...repo,
  id: 'repo-env-twin',
  path: '/home/brennan/orca',
  connectionId: null,
  executionHostId: ENV_HOST_ID
}

function setupFor(target: Repo, hostId: ExecutionHostId): ProjectHostSetup {
  return {
    ...projectHostSetups[0]!,
    id: target.id,
    projectId: project.id,
    hostId,
    repoId: target.id,
    path: target.path,
    displayName: target.displayName
  }
}

const TWIN_GROUPING = {
  projects: [{ ...project, sourceRepoIds: [repo.id, sshTwin.id, envTwin.id] }],
  projectHostSetups: [
    projectHostSetups[0]!,
    setupFor(sshTwin, SSH_HOST_ID),
    setupFor(envTwin, ENV_HOST_ID)
  ]
}

const TWIN_REPO_MAP = new Map([
  [repo.id, repo],
  [sshTwin.id, sshTwin],
  [envTwin.id, envTwin]
])

function detected(path: string): DetectedWorktree {
  return { path, visible: false } as DetectedWorktree
}

/** Counts differ per record — the reporting account's 61 vs 134. */
const INBOX_COUNTS: Record<string, number> = { [sshTwin.id]: 61, [envTwin.id]: 134 }

function inboxMap(repoIds: readonly string[]): Map<string, unknown> {
  return new Map(
    repoIds.map((repoId) => [
      repoId,
      {
        repo: TWIN_REPO_MAP.get(repoId)!,
        inboxWorktrees: Array.from({ length: INBOX_COUNTS[repoId] ?? 1 }, (_unused, index) =>
          detected(`/inbox/${repoId}/${index}`)
        )
      }
    ])
  )
}

function noticeRows(args: {
  /** Host-filtered: only these records still have notice candidates. */
  eligibleRepoIds: readonly string[]
  worktrees?: Worktree[]
  repoMap?: Map<string, Repo>
  grouping?: typeof TWIN_GROUPING
}): Extract<Row, { type: 'new-external-worktrees-inbox' }>[] {
  const rows = buildRows(
    'repo',
    args.worktrees ?? [worktree],
    args.repoMap ?? TWIN_REPO_MAP,
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(),
    new Map(),
    inboxMap(args.eligibleRepoIds) as never,
    [],
    args.grouping ?? TWIN_GROUPING,
    [],
    HOST_LABELS
  )
  return rows.filter((row) => row.type === 'new-external-worktrees-inbox')
}

function summarize(
  rows: Extract<Row, { type: 'new-external-worktrees-inbox' }>[]
): { repoId: string; label: string | undefined; hostId: string | undefined; count: number }[] {
  return rows.map((row) => ({
    repoId: row.repo.id,
    label: row.hostContextLabel,
    // Carried so the row can draw the host glyph; two hosts sharing a label
    // differ only here.
    hostId: row.hostContextHostId,
    count: row.inboxWorktrees.length
  }))
}

describe('discovery notice rows on a multi-host project', () => {
  it('labels both rows when two distinct hosts share one label', () => {
    // Kills the label-counting gate, so the project must contain ONLY the two
    // same-label hosts: a third host with a different label would supply the
    // label diversity the old gate needed and the test would pass either way.
    expect(
      summarize(
        noticeRows({
          eligibleRepoIds: [sshTwin.id, envTwin.id],
          repoMap: new Map([
            [sshTwin.id, sshTwin],
            [envTwin.id, envTwin]
          ]),
          grouping: {
            projects: [{ ...project, sourceRepoIds: [sshTwin.id, envTwin.id] }],
            projectHostSetups: [setupFor(sshTwin, SSH_HOST_ID), setupFor(envTwin, ENV_HOST_ID)]
          }
        })
      )
    ).toEqual([
      { repoId: sshTwin.id, label: 'openclaw', hostId: SSH_HOST_ID, count: 61 },
      { repoId: envTwin.id, label: 'openclaw', hostId: ENV_HOST_ID, count: 134 }
    ])
  })

  it('labels a lone eligible row on a project that spans hosts', () => {
    // Kills notice-row-scoped membership: only one record emits a row, but the
    // project still spans hosts, so the row must say which host it is.
    expect(summarize(noticeRows({ eligibleRepoIds: [envTwin.id] }))).toEqual([
      { repoId: envTwin.id, label: 'openclaw', hostId: ENV_HOST_ID, count: 134 }
    ])
  })

  it('keeps each row its own label and count under either host filter', () => {
    // Kills the collapse (both rows survive with distinct counts) and proves the
    // gate reads the unfiltered universe (each filtered survivor keeps its label).
    expect(summarize(noticeRows({ eligibleRepoIds: [sshTwin.id] }))).toEqual([
      { repoId: sshTwin.id, label: 'openclaw', hostId: SSH_HOST_ID, count: 61 }
    ])
    expect(summarize(noticeRows({ eligibleRepoIds: [envTwin.id] }))).toEqual([
      { repoId: envTwin.id, label: 'openclaw', hostId: ENV_HOST_ID, count: 134 }
    ])
  })

  it('returns labels for exactly the eligible records, never the filtered-out ones', () => {
    // A row-level test cannot see an extra ineligible entry, because no row
    // consumes it; only exact map membership pins the intersection.
    const index = buildProjectGroupingIndex(TWIN_GROUPING)

    for (const eligible of [[sshTwin.id], [envTwin.id], [sshTwin.id, envTwin.id]]) {
      const labels = getNoticeHostContextLabels(
        eligible,
        TWIN_REPO_MAP.keys(),
        TWIN_REPO_MAP,
        index,
        HOST_LABELS
      )
      expect([...(labels?.keys() ?? [])]).toEqual(eligible)
    }
  })

  it('leaves a single-host project unlabelled even with several records on it', () => {
    // Regression pin: guards a future implementation that counts records
    // instead of distinct host ids.
    const secondLocal: Repo = { ...repo, id: 'repo-local-2', path: '/tmp/orca-second' }
    const rows = noticeRows({
      eligibleRepoIds: [repo.id],
      repoMap: new Map([
        [repo.id, repo],
        [secondLocal.id, secondLocal]
      ]),
      grouping: {
        projects: [{ ...project, sourceRepoIds: [repo.id, secondLocal.id] }],
        projectHostSetups: [projectHostSetups[0]!, setupFor(secondLocal, 'local')]
      }
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('hostContextLabel')
  })
})
