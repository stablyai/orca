import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  buildBotWorkerOwners,
  resolveSidebarRevealTarget,
  sidebarRevealTargetKey,
  type SidebarRevealOwner,
  type SidebarRevealTarget,
  type SidebarRevealTargetInputs
} from './sidebar-reveal-target'

function home(id: string, executionHostId?: 'ssh:box'): FolderWorkspace {
  return {
    id,
    projectGroupId: 'bots',
    name: id,
    folderPath: `/bots/${id}`,
    connectionId: null,
    ...(executionHostId ? { executionHostId } : {}),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function line(id: string, hostId: 'local' | 'ssh:box' = 'local'): Worktree {
  return {
    id,
    hostId,
    repoId: 'repo',
    path: `/w/${id}`,
    head: 'abc',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
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
}

const scoutHome = home('scout-home')
const remoteHome = home('remote-home', 'ssh:box')
const groupHome = home('group-home')

function owner(
  kind: 'bot' | 'group',
  entryKey: string,
  workspace: FolderWorkspace,
  extra: Partial<SidebarRevealOwner> = {}
): SidebarRevealOwner {
  return { kind, entryKey, home: workspace, hidden: false, hostDown: false, ...extra }
}

const fixLogin = line('fix-login')
const fixLoginChild = line('fix-login-child')
const remoteSameId = line('fix-login', 'ssh:box')

const children = new Map<string, Worktree[]>([
  [getFolderWorkspaceHostIdentity(scoutHome), [fixLogin]],
  [getWorktreeHostIdentity(fixLogin), [fixLoginChild]],
  [getFolderWorkspaceHostIdentity(remoteHome), [remoteSameId]]
])

function inputs(overrides: Partial<SidebarRevealTargetInputs> = {}): SidebarRevealTargetInputs {
  const owners = overrides.owners ?? [
    owner('bot', 'local/scout', scoutHome),
    owner('bot', 'ssh:box/remote', remoteHome),
    owner('group', 'local/crew', groupHome)
  ]
  return {
    activeView: 'terminal',
    activeWorkspaceId: 'folder:scout-home',
    activeHostId: 'local',
    frontTab: null,
    activeIsArchived: false,
    botsEnabled: true,
    hideBotCreatedWorkspaces: true,
    owners,
    workerOwners: buildBotWorkerOwners(owners, children),
    ...overrides
  }
}

describe('resolveSidebarRevealTarget', () => {
  const cases: [string, Partial<SidebarRevealTargetInputs>, SidebarRevealTarget][] = [
    [
      'bot home with a chat tab in front',
      { frontTab: { contentType: 'agent-session', entityId: 'chat-7' } },
      { section: 'bots', entryKey: 'local/scout', chatId: 'chat-7', hostDown: false }
    ],
    [
      'bot home with a terminal tab in front',
      { frontTab: { contentType: 'terminal', entityId: 'pty-1' } },
      { section: 'bots', entryKey: 'local/scout', hostDown: false }
    ],
    [
      'a group home never names a chat',
      {
        activeWorkspaceId: 'folder:group-home',
        frontTab: { contentType: 'agent-session', entityId: 'member-session' }
      },
      { section: 'bots', entryKey: 'local/crew', hostDown: false }
    ],
    [
      'plain worktree',
      { activeWorkspaceId: 'plain' },
      { section: 'projects', worktreeId: 'plain', executionHostId: 'local' }
    ],
    [
      'archived worktree',
      { activeWorkspaceId: 'plain', activeIsArchived: true },
      {
        section: 'none',
        reason: 'archived'
      }
    ],
    ['nothing open', { activeWorkspaceId: null }, { section: 'none', reason: 'no-workspace' }],
    ['bots off on a bot page', { botsEnabled: false }, { section: 'none', reason: 'bots-off' }]
  ]
  it.each(cases)('%s', (_name, overrides, expected) => {
    expect(resolveSidebarRevealTarget(inputs(overrides))).toEqual(expected)
  })

  it('does not reveal a workspace while settings is open', () => {
    expect(resolveSidebarRevealTarget(inputs({ activeView: 'settings' }))).toEqual({
      section: 'none',
      reason: 'full-page-view'
    })
  })

  it('a paused bot hidden by Bot options has no row, nor do its workers', () => {
    const owners = [owner('bot', 'local/scout', scoutHome, { hidden: true })]
    expect(resolveSidebarRevealTarget(inputs({ owners }))).toEqual({
      section: 'none',
      reason: 'bot-hidden'
    })
    expect(resolveSidebarRevealTarget(inputs({ owners, activeWorkspaceId: fixLogin.id }))).toEqual({
      section: 'none',
      reason: 'bot-hidden'
    })
  })

  it('a nested worker names the lines above it, root first', () => {
    const target = resolveSidebarRevealTarget(inputs({ activeWorkspaceId: fixLoginChild.id }))
    expect(target).toMatchObject({
      section: 'bots',
      entryKey: 'local/scout',
      worker: { id: fixLoginChild.id, ancestors: [{ id: fixLogin.id, hostId: 'local' }] }
    })
  })

  it('the same worktree id on two hosts belongs to each host’s own bot', () => {
    expect(
      resolveSidebarRevealTarget(
        inputs({ activeWorkspaceId: 'fix-login', activeHostId: 'ssh:box' })
      )
    ).toMatchObject({ section: 'bots', entryKey: 'ssh:box/remote' })
    expect(
      resolveSidebarRevealTarget(inputs({ activeWorkspaceId: fixLogin.id, activeHostId: 'local' }))
    ).toEqual({
      section: 'bots',
      entryKey: 'local/scout',
      worker: {
        id: 'fix-login',
        hostId: 'local',
        identity: getWorktreeHostIdentity(fixLogin),
        ancestors: []
      },
      hostDown: false
    })
    // No host named and two copies: no guess, so it stays the Projects list's.
    expect(
      resolveSidebarRevealTarget(inputs({ activeWorkspaceId: 'fix-login', activeHostId: null }))
    ).toMatchObject({ section: 'projects' })
  })

  it('a worker of a bot whose server is down reveals only that bot’s row', () => {
    const owners = [owner('bot', 'local/scout', scoutHome, { hostDown: true })]
    expect(
      resolveSidebarRevealTarget(inputs({ owners, activeWorkspaceId: fixLogin.id }))
    ).toMatchObject({ section: 'bots', entryKey: 'local/scout', hostDown: true })
  })

  it('with Hide bot workspaces off, or bots off, a worker is a Projects row', () => {
    expect(
      resolveSidebarRevealTarget(
        inputs({ activeWorkspaceId: fixLogin.id, hideBotCreatedWorkspaces: false })
      )
    ).toMatchObject({ section: 'projects', worktreeId: fixLogin.id })
    expect(
      resolveSidebarRevealTarget(inputs({ activeWorkspaceId: fixLogin.id, botsEnabled: false }))
    ).toMatchObject({ section: 'projects', worktreeId: fixLogin.id })
  })
})

describe('buildBotWorkerOwners', () => {
  it('maps each line to its own bot across several bots and leaves groups out', () => {
    const otherHome = home('other-home')
    const otherLine = line('other-line')
    const owners = [
      owner('bot', 'local/scout', scoutHome),
      owner('bot', 'local/other', otherHome),
      owner('group', 'local/crew', groupHome)
    ]
    const map = buildBotWorkerOwners(
      owners,
      new Map([
        ...children,
        [getFolderWorkspaceHostIdentity(otherHome), [otherLine]],
        [getFolderWorkspaceHostIdentity(groupHome), [line('room-work')]]
      ])
    )
    expect(map.get(getWorktreeHostIdentity(fixLogin))?.entryKey).toBe('local/scout')
    expect(map.get(getWorktreeHostIdentity(otherLine))?.entryKey).toBe('local/other')
    expect(map.has(getWorktreeHostIdentity(line('room-work')))).toBe(false)
  })
})

describe('sidebarRevealTargetKey', () => {
  it('changes when the chat in front changes', () => {
    const one = resolveSidebarRevealTarget(
      inputs({ frontTab: { contentType: 'agent-session', entityId: 'a' } })
    )
    const two = resolveSidebarRevealTarget(
      inputs({ frontTab: { contentType: 'agent-session', entityId: 'b' } })
    )
    expect(sidebarRevealTargetKey(one)).not.toBe(sidebarRevealTargetKey(two))
  })
})
