import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarInputsFeed } from '../../main/runtime/sidebar-inputs/sidebar-inputs-feed'
import { testDomain } from '../../main/runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import type { SidebarInputsChangedEvent } from '../sidebar-list/sidebar-inputs-feed-contract'
import { indexSidebarFeed } from '../sidebar-list/sidebar-feed-index'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { WorkspaceRowsSnapshotSchema, type WorkspaceRow } from '../sidebar-list/workspace-rows'
import { SidebarFeedReader, type SidebarFeedReaderRead } from './sidebar-feed-reader'
import { installSidebarFeedSnapshot, type SidebarFeedSnapshot } from './sidebar-feed-snapshot'

const WORKSPACES = 1000

function row(index: number, overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  const id = `repo-1::/w/${index}`
  return {
    id,
    hostId: 'local',
    kind: 'git',
    repoId: 'repo-1',
    path: `/w/${index}`,
    branch: `refs/heads/b${index}`,
    displayName: `b${index}`,
    isMainWorktree: false,
    lineage: null,
    isPinned: false,
    isArchived: false,
    isUnread: false,
    workspaceStatus: 'in-progress',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedItems: [],
    defaultBranch: false,
    ...overrides
  }
}

const identity = (index: number) => composeWorktreeHostIdentity('local', `repo-1::/w/${index}`)

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** A host with WORKSPACES rows and a review fact, read through the shared reader. */
async function readHost() {
  const workspaces = testDomain(
    'workspaces',
    Object.fromEntries(
      Array.from({ length: WORKSPACES }, (_, index) => [identity(index), row(index)])
    )
  )
  const review = testDomain('review', {
    [identity(0)]: { provider: 'github', reviewState: 'open' }
  })
  const notices: SidebarInputsChangedEvent[] = []
  const feed = new SidebarInputsFeed(
    () => [workspaces.domain, review.domain],
    (event) => notices.push(event)
  )
  feed.acquire('phone')
  const reads: SidebarFeedReaderRead[] = []
  const reader = new SidebarFeedReader(
    async (params) => ({ kind: 'answered', reply: await feed.read(params) }),
    { retryDelayMs: () => null },
    (read) => reads.push(read)
  )
  reader.refresh()
  await settle()
  const snapshot = (): SidebarFeedSnapshot => reads.at(-1)!.snapshot!
  /** Writes one row on the host and follows its notice to the next install. */
  const write = async (index: number, overrides: Partial<WorkspaceRow>): Promise<void> => {
    const before = snapshot()
    workspaces.set(identity(index), row(index, overrides))
    await vi.waitFor(() =>
      expect(notices.at(-1)?.revision).toBeGreaterThan(before.installed.revision)
    )
    reader.changed(notices.at(-1)!)
    await vi.waitFor(() => expect(snapshot()).not.toBe(before))
  }
  return { snapshot, write, reads }
}

describe('sidebar feed snapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-derives only the one workspace an unread change touches', async () => {
    const host = await readHost()
    const before = host.snapshot()
    const indexBefore = indexSidebarFeed(before.domains, [])
    expect(before.domains.workspaces.size).toBe(WORKSPACES)

    const parse = vi.spyOn(WorkspaceRowsSnapshotSchema.shape.rows.valueType, 'safeParse')
    await host.write(7, { isUnread: true })
    const after = host.snapshot()
    const indexAfter = indexSidebarFeed(after.domains, [])

    // One row parsed again, and only its decoded and indexed objects are new.
    expect(parse).toHaveBeenCalledTimes(1)
    const changedRows = [...after.domains.workspaces].filter(
      ([key, value]) => before.domains.workspaces.get(key) !== value
    )
    expect(changedRows.map(([key]) => key)).toEqual([identity(7)])
    expect(after.domains.workspaces.get(identity(7))?.isUnread).toBe(true)
    const rederived = indexAfter.workspaces.filter(
      (entry, position) => indexBefore.workspaces[position] !== entry
    )
    expect(rederived.map((entry) => entry.identity)).toEqual([identity(7)])
    // A domain the change did not touch keeps its map.
    expect(after.domains.review).toBe(before.domains.review)
  })

  it('keeps the snapshot itself when the install is the same', async () => {
    const host = await readHost()
    const snapshot = host.snapshot()
    expect(installSidebarFeedSnapshot(snapshot.installed, snapshot)).toBe(snapshot)
  })
})
