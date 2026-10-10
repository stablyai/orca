import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { makeWorktree } from '../components/automations/automations-page-fixtures'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { worktreeSelectionOwnerForRow } from '../lib/worktree-selection-owner'
import {
  applyStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'

const initial = useAppStore.getState()
const id = 'repo-local-owner::/repo/chat'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  useAppStore.setState(initial, true)
})

function fixture(identified = true) {
  const repo = repoWithFetchedOwner(
    {
      id: 'repo-local-owner',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 1,
      executionHostId: 'local'
    },
    { kind: 'local' }
  )
  const identity = createWorktreeIdentity({
    worktreeId: id,
    executionHostId: 'local',
    instanceId: randomUUID()
  })
  const row = makeWorktree({
    id,
    repoId: repo.id,
    path: '/repo/chat',
    hostId: 'local',
    instanceId: identity.instanceId,
    identity
  })
  const owner = worktreeSelectionOwnerForRow(row, [repo])
  expect(owner).toMatchObject({ publisherHostId: 'local', executionHostId: 'local' })
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [row] },
    detectedWorktreesByRepo: {},
    activeWorktreeId: id,
    activeWorkspaceOwner: owner,
    activeWorkspaceExecutionHostId: 'local',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {}
  })
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: id,
    publicationEpoch: 'structured-owner',
    snapshotVersion: 1,
    ...(identified ? { worktreeIdentity: identity } : {}),
    activeTabId: 'agent-session:owner-chat',
    activeTabType: 'agent-session',
    activeGroupId: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:owner-chat',
        title: 'Codex Chat',
        sessionId: 'owner-chat',
        agent: 'codex',
        isActive: true
      }
    ]
  }
  return { repo, row, identity, snapshot }
}

describe('real local structured producer retains checked workspace ownership', () => {
  it.each([false, true])('publishes the selected local chat, identity:%s', (identified) => {
    const f = fixture(identified)
    applyStructuredSessionTabSnapshots([f.snapshot])
    expect(useAppStore.getState().unifiedTabsByWorktree[id]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'owner-chat' })])
    )
  })

  it('refuses a foreign publisher at the same local projection boundary', () => {
    const f = fixture(false)
    applyStructuredSessionTabSnapshots([f.snapshot], 'foreign-publisher')
    expect(useAppStore.getState().unifiedTabsByWorktree[id]).toBeUndefined()
  })

  it('refuses a retired local instance', () => {
    const f = fixture()
    const retired = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'local',
      instanceId: randomUUID()
    })
    applyStructuredSessionTabSnapshots([{ ...f.snapshot, worktreeIdentity: retired }])
    expect(useAppStore.getState().unifiedTabsByWorktree[id]).toBeUndefined()
  })

  it('refuses unqualified local and SSH twins', () => {
    const f = fixture(false)
    const sshIdentity = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'ssh:local-sibling',
      instanceId: randomUUID()
    })
    const sshRepo = {
      ...f.repo,
      executionHostId: sshIdentity.executionHostId,
      connectionId: 'local-sibling'
    }
    const sshRow = {
      ...f.row,
      hostId: sshIdentity.executionHostId,
      instanceId: sshIdentity.instanceId,
      identity: sshIdentity
    }
    useAppStore.setState({
      repos: [f.repo, sshRepo],
      worktreesByRepo: { [f.repo.id]: [f.row, sshRow] },
      activeWorktreeId: null,
      activeWorkspaceOwner: null,
      activeWorkspaceExecutionHostId: null
    })
    applyStructuredSessionTabSnapshots([f.snapshot])
    expect(useAppStore.getState().unifiedTabsByWorktree[id]).toBeUndefined()
  })

  it('keeps local inventory away from a paired publisher', () => {
    const f = fixture()
    const repo = repoWithFetchedOwner(f.repo, {
      kind: 'environment',
      environmentId: 'paired-owner'
    })
    const row = withRepoHostOwnership(f.row, 'runtime:paired-owner')
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [row] },
      activeWorkspaceOwner: worktreeSelectionOwnerForRow(row, [repo]),
      activeWorkspaceExecutionHostId: 'runtime:paired-owner'
    })
    applyStructuredSessionTabSnapshots([f.snapshot])
    expect(useAppStore.getState().unifiedTabsByWorktree[id]).toBeUndefined()
  })
})
