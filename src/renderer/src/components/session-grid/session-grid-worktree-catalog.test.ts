import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildSessionGridWorktreeCatalog,
  sessionGridWorktreeLabel
} from './session-grid-worktree-catalog'

const repos = [
  { id: 'repo-1', displayName: 'sytio' },
  { id: 'repo-2', displayName: 'orca' }
] as unknown as Repo[]
const worktreesByRepo = {
  'repo-1': [{ id: 'wt-1', displayName: 'sytio', path: '/s' }],
  'repo-2': [{ id: 'wt-2', displayName: 'orca-feature', path: '/o' }],
  'repo-gone': [{ id: 'wt-3', displayName: 'orphan', path: '/x' }]
} as unknown as Record<string, Worktree[]>

describe('buildSessionGridWorktreeCatalog naming', () => {
  it('names a worktree whose custom name was cleared by its branch, never "undefined"', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-2': [
          { id: 'wt-x', displayName: undefined, branch: 'refs/heads/feat/x', path: '/o/x' }
        ]
      } as unknown as Record<string, Worktree[]>,
      repos
    })
    expect(byWorktreeId.get('wt-x')).toMatchObject({
      worktreeName: 'feat/x',
      branch: 'feat/x',
      label: 'orca / feat/x'
    })
  })

  it('keeps a folder workspace branchless and falls back to its folder name', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-f', displayName: '', branch: '', path: '/home/dev/notes' }]
      } as unknown as Record<string, Worktree[]>,
      repos
    })
    expect(byWorktreeId.get('wt-f')).toMatchObject({
      worktreeName: 'notes',
      label: 'sytio / notes'
    })
    expect(byWorktreeId.get('wt-f')?.branch).toBeUndefined()
  })
})

describe('buildSessionGridWorktreeCatalog', () => {
  it('collapses the label to the name when worktree and repo coincide', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({ worktreesByRepo, repos })
    expect(byWorktreeId.get('wt-1')?.label).toBe('sytio')
    expect(byWorktreeId.get('wt-2')?.label).toBe('orca / orca-feature')
  })

  it('falls back to generic names for a repo it cannot resolve, and for an unknown worktree', () => {
    const { byWorktreeId, byRepo } = buildSessionGridWorktreeCatalog({ worktreesByRepo, repos })
    expect(byRepo.find((g) => g.repoId === 'repo-gone')?.repoName).toBe('Project')
    expect(sessionGridWorktreeLabel(byWorktreeId.get('nope'))).toBe('Workspace')
  })

  it('groups by repo in catalog order for the launch menus', () => {
    const { byRepo } = buildSessionGridWorktreeCatalog({ worktreesByRepo, repos })
    expect(byRepo.map((g) => [g.repoName, g.worktrees.map((w) => w.worktreeName)])).toEqual([
      ['sytio', ['sytio']],
      ['orca', ['orca-feature']],
      ['Project', ['orphan']]
    ])
  })

  it('drops a repo with no worktrees, so the picker never shows an empty group', () => {
    const catalog = buildSessionGridWorktreeCatalog({
      worktreesByRepo: { 'repo-1': [] } as unknown as Record<string, Worktree[]>,
      repos
    })
    expect(catalog.byRepo).toEqual([])
    expect(catalog.byWorktreeId.size).toBe(0)
  })

  it('offers folder workspaces as launch targets, grouped by their project group', () => {
    const folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'group-1', name: 'notes', folderPath: '/home/dev/notes' },
      { id: 'fw-2', projectGroupId: 'group-1', name: 'scratch', folderPath: '/home/dev/scratch' }
    ] as unknown as FolderWorkspace[]
    const projectGroups = [{ id: 'group-1', name: 'Folders' }] as unknown as ProjectGroup[]

    const { byRepo, byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {},
      repos: [],
      folderWorkspaces,
      projectGroups
    })

    expect(byRepo.map((g) => [g.repoName, g.worktrees.map((w) => w.worktreeName)])).toEqual([
      ['Folders', ['notes', 'scratch']]
    ])
    // The `folder:` key every tab and pty map uses, so launching one works.
    expect(byWorktreeId.get('folder:fw-1')).toMatchObject({
      label: 'Folders / notes',
      path: '/home/dev/notes'
    })
    expect(byWorktreeId.get('folder:fw-1')?.branch).toBeUndefined()
  })
})

describe('buildSessionGridWorktreeCatalog execution hosts', () => {
  const sshRepos = [
    { id: 'repo-ssh', displayName: 'orca', connectionId: 'box' },
    { id: 'repo-1', displayName: 'sytio' }
  ] as unknown as Repo[]
  const sshWorktrees = {
    'repo-ssh': [{ id: 'wt-ssh', displayName: 'orca', path: '/srv/orca' }],
    'repo-1': [{ id: 'wt-local', displayName: 'sytio', path: '/s' }]
  } as unknown as Record<string, Worktree[]>

  it('names the SSH host of a remote workspace and leaves a local one unnamed', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: sshWorktrees,
      repos: sshRepos,
      sshTargetLabels: new Map([['box', 'build box']])
    })

    expect(byWorktreeId.get('wt-ssh')).toMatchObject({
      hostKind: 'ssh',
      executionHostId: 'ssh:box',
      hostLabel: 'build box'
    })
    expect(byWorktreeId.get('wt-local')).toMatchObject({
      hostKind: 'local',
      executionHostId: 'local'
    })
    expect(byWorktreeId.get('wt-local')?.hostLabel).toBeUndefined()
  })

  it('falls back to the bare target id when no label is registered for it', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: sshWorktrees,
      repos: sshRepos
    })
    expect(byWorktreeId.get('wt-ssh')?.hostLabel).toBe('box')
  })

  it("lets the user's host rename win over the target's own label", () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: sshWorktrees,
      repos: sshRepos,
      sshTargetLabels: new Map([['box', 'build box']]),
      hostSettingOverrides: { 'ssh:box': { displayLabel: 'the loud one' } }
    })
    expect(byWorktreeId.get('wt-ssh')?.hostLabel).toBe('the loud one')
  })

  it('calls a paired runtime environment remote, and names it after the environment', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-rt', displayName: 'sytio', path: '/s', hostId: 'runtime:env-1' }]
      } as unknown as Record<string, Worktree[]>,
      repos,
      runtimeEnvironments: [{ id: 'env-1', name: 'studio' }]
    })
    expect(byWorktreeId.get('wt-rt')).toMatchObject({
      hostKind: 'remote',
      executionHostId: 'runtime:env-1',
      hostLabel: 'studio'
    })
  })

  it('gives a folder workspace the host of the group it was imported from', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {},
      repos: [],
      folderWorkspaces: [
        { id: 'fw-1', projectGroupId: 'group-1', name: 'notes', folderPath: '/srv/notes' }
      ] as unknown as FolderWorkspace[],
      projectGroups: [
        { id: 'group-1', name: 'Folders', connectionId: 'box' }
      ] as unknown as ProjectGroup[],
      sshTargetLabels: new Map([['box', 'build box']])
    })
    // The projection folds only the workspace's OWN connectionId into `hostId`, so the group's
    // reaches the kind but not the id — the badge says SSH without naming the box. Same pair the
    // dashboard produces for this workspace; the grid must not invent a second answer.
    expect(byWorktreeId.get('folder:fw-1')).toMatchObject({
      hostKind: 'ssh',
      executionHostId: 'local'
    })
    expect(byWorktreeId.get('folder:fw-1')?.hostLabel).toBeUndefined()
  })

  it('names the SSH host of a folder workspace connected on its own', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {},
      repos: [],
      folderWorkspaces: [
        {
          id: 'fw-3',
          projectGroupId: 'group-1',
          name: 'notes',
          folderPath: '/srv/notes',
          connectionId: 'box'
        }
      ] as unknown as FolderWorkspace[],
      projectGroups: [{ id: 'group-1', name: 'Folders' }] as unknown as ProjectGroup[],
      sshTargetLabels: new Map([['box', 'build box']])
    })
    expect(byWorktreeId.get('folder:fw-3')).toMatchObject({
      hostKind: 'ssh',
      executionHostId: 'ssh:box',
      hostLabel: 'build box'
    })
  })

  it('keeps a local folder workspace local even inside a remote group it overrides', () => {
    const { byWorktreeId } = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {},
      repos: [],
      folderWorkspaces: [
        {
          id: 'fw-2',
          projectGroupId: 'group-1',
          name: 'scratch',
          folderPath: '/home/dev/scratch',
          executionHostId: 'local'
        }
      ] as unknown as FolderWorkspace[],
      projectGroups: [{ id: 'group-1', name: 'Folders' }] as unknown as ProjectGroup[]
    })
    expect(byWorktreeId.get('folder:fw-2')).toMatchObject({
      hostKind: 'local',
      executionHostId: 'local'
    })
  })
})
