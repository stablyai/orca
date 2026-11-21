import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../worktree/catalog/runtime-worktree-contracts'
import { nameBotOwners } from './bot-workspace-owner'

type Fields = Pick<RuntimeWorktreePsSummary, 'worktreeId'> &
  Partial<
    Pick<
      RuntimeWorktreePsSummary,
      'hostId' | 'worktreeInstanceId' | 'parentWorktreeId' | 'crossStoreParent' | 'bot' | 'botHome'
    >
  >

const row = (fields: Fields): RuntimeWorktreePsSummary =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership reads only these fields and isArchived.
  ({ isArchived: false, parentWorktreeId: null, ...fields }) as RuntimeWorktreePsSummary

const home = row({ worktreeId: 'folder:home-1', hostId: 'local', bot: 'Triage', botHome: true })

// A worker the bot started on a paired server, nested under the bot's home on this computer.
const remoteChild = (parentInstallationId: string) =>
  row({
    worktreeId: 'repo-s::/srv/p2-child',
    hostId: 'runtime:env-1',
    worktreeInstanceId: 'p2-instance',
    crossStoreParent: {
      childWorkspaceKey: 'worktree:repo-s::/srv/p2-child',
      childInstanceId: 'p2-instance',
      parent: {
        installationId: parentInstallationId,
        workspaceKey: 'folder:home-1',
        instanceId: 'home-1'
      },
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      createdAt: 1
    }
  })

const grandchild = row({
  worktreeId: 'repo-s::/srv/p2-grandchild',
  hostId: 'runtime:env-1',
  worktreeInstanceId: 'g-instance',
  parentWorktreeId: 'repo-s::/srv/p2-child'
})

const topLevel = row({
  worktreeId: 'repo-s::/srv/p1-top',
  hostId: 'runtime:env-1',
  worktreeInstanceId: 'p1-instance'
})

const botsOf = (rows: RuntimeWorktreePsSummary[]) =>
  Object.fromEntries(rows.map((entry) => [entry.worktreeId, entry.bot]))

describe('nameBotOwners', () => {
  it("names a paired server's workspaces under a bot home on this computer, children too", () => {
    const named = nameBotOwners([
      { rows: [home], installationId: 'home-installation' },
      {
        rows: [remoteChild('home-installation'), grandchild, topLevel],
        environmentId: 'env-1',
        installationId: 'server-installation'
      }
    ])
    expect(botsOf(named)).toEqual({
      'folder:home-1': 'Triage',
      'repo-s::/srv/p2-child': 'Triage',
      'repo-s::/srv/p2-grandchild': 'Triage',
      'repo-s::/srv/p1-top': undefined
    })
  })

  it('names no bot when the parent names another store or the server predates its identity', () => {
    const otherStore = nameBotOwners([
      { rows: [home], installationId: 'home-installation' },
      {
        rows: [remoteChild('another-installation')],
        environmentId: 'env-1',
        installationId: 'server-installation'
      }
    ])
    const olderServer = nameBotOwners([
      { rows: [home], installationId: 'home-installation' },
      { rows: [remoteChild('home-installation')], environmentId: 'env-1' }
    ])
    expect(otherStore[1].bot).toBeUndefined()
    expect(olderServer[1].bot).toBeUndefined()
  })
})
