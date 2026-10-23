import { describe, expect, it } from 'vitest'
import { buildResourcePtyRows, groupResourcePtyRows } from './resource-pty-view-model'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  makeFolderWorkspace,
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../worktree-jump-palette-test-fixtures'
import { makeProjectGroup } from '../sidebar/folder-workspace-composer-submit-fixtures'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const leaf = '11111111-1111-4111-8111-111111111111'
const session = (id: string, overrides: Partial<PtyListedSession> = {}): PtyListedSession => ({
  id,
  incarnationId: 'A',
  cwd: '/notes',
  title: 'Shell',
  agentOwnership: 'unknown',
  ...overrides
})
const base = () => ({
  sessions: [session('pty-tab')],
  bindings: {
    tabsByWorktree: { 'wt-1': [makeTerminalTab('tab', 'wt-1', 'Terminal 1')] },
    ptyIdsByTabId: {},
    workspaceSessionReady: true
  },
  repos: [makeRepo()],
  worktrees: [makeWorktree('wt-1', 'Notes')],
  projectGroups: [],
  runtimePaneTitlesByTabId: {}
})

describe('local PTY view model', () => {
  it('keeps distinct process generations with the same terminal id as separate rows', () => {
    const rows = buildResourcePtyRows({
      ...base(),
      sessions: [session('same', { incarnationId: 'A' }), session('same', { incarnationId: 'B' })]
    })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.identity)).size).toBe(2)
  })

  it('counts a session once across multiple bound panes and navigates to the matching leaf', () => {
    const inputs = base()
    const otherLeaf = '22222222-2222-4222-8222-222222222222'
    const rows = buildResourcePtyRows({
      ...inputs,
      sessions: [...inputs.sessions, ...inputs.sessions],
      bindings: {
        ...inputs.bindings,
        tabsByWorktree: {
          'wt-1': [
            ...inputs.bindings.tabsByWorktree['wt-1'],
            makeTerminalTab('other', 'wt-1', 'Other')
          ]
        },
        ptyIdsByTabId: { tab: ['pty-tab', 'pty-tab'], other: ['pty-tab'] },
        terminalLayoutsByTabId: {
          other: {
            root: { type: 'leaf', leafId: otherLeaf },
            activeLeafId: otherLeaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [otherLeaf]: 'pty-tab' }
          },
          tab: {
            root: { type: 'leaf', leafId: leaf },
            activeLeafId: leaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leaf]: 'pty-tab' }
          }
        }
      }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      binding: 'bound',
      tabId: 'tab',
      paneKey: makePaneKey('tab', leaf),
      workspace: 'Notes'
    })
  })

  it('binds only the established route when daemon generations reuse a terminal id', () => {
    const inputs = base()
    const rows = buildResourcePtyRows({
      ...inputs,
      sessions: [
        session('pty-tab', { incarnationId: 'A', inventorySourceId: 'first', routed: false }),
        session('pty-tab', { incarnationId: 'B', inventorySourceId: 'second', routed: true })
      ]
    })
    expect(rows[0]).toMatchObject({
      binding: 'unbound',
      tabId: null,
      paneKey: null,
      workspace: null
    })
    expect(rows[1]).toMatchObject({ binding: 'bound', tabId: 'tab', workspace: 'Notes' })
  })

  it('keeps duplicate bindings uncertain when a publisher cannot identify the route', () => {
    const rows = buildResourcePtyRows({
      ...base(),
      sessions: [
        session('pty-tab', { incarnationId: 'A' }),
        session('pty-tab', { incarnationId: 'B' })
      ]
    })
    expect(rows.every((row) => row.binding === 'pending' && row.tabId === null)).toBe(true)
  })

  it('keeps legacy processes from distinct daemons as separate rows without incarnation metadata', () => {
    const rows = buildResourcePtyRows({
      ...base(),
      sessions: [
        session('same', {
          incarnationId: undefined,
          inventorySourceId: 'first',
          rootProcessId: 101
        }),
        session('same', {
          incarnationId: undefined,
          inventorySourceId: 'second',
          rootProcessId: 202
        })
      ]
    })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.identity)).size).toBe(2)
  })

  it('uses inactive saved tab bindings and keeps restore-pending distinct from unbound', () => {
    const inputs = base()
    expect(buildResourcePtyRows(inputs)[0]?.binding).toBe('bound')
    expect(
      buildResourcePtyRows({
        ...inputs,
        bindings: { ...inputs.bindings, workspaceSessionReady: false }
      })[0]?.binding
    ).toBe('pending')
  })

  it('groups folder workspaces without git metadata and puts unknown attribution in Unassigned', () => {
    const folder = folderWorkspaceToWorktree(makeFolderWorkspace())
    const rows = buildResourcePtyRows({
      ...base(),
      worktrees: [folder],
      projectGroups: [makeProjectGroup()],
      sessions: [session('folder-pty', { worktreeId: folder.id }), session('unknown')]
    })
    const groups = groupResourcePtyRows(rows)
    expect(groups.find((group) => group.id === folder.repoId)).toMatchObject({
      name: 'Platform',
      workspaces: [{ name: 'Design workspace' }]
    })
    expect(groups.find((group) => group.id === '')?.workspaces[0]?.rows[0]?.session.id).toBe(
      'unknown'
    )
  })

  it('keeps saved remote bindings out of local actions', () => {
    const inputs = base()
    const rows = buildResourcePtyRows({
      ...inputs,
      repos: [{ ...makeRepo(), connectionId: 'ssh-host' }]
    })
    expect(rows[0]).toMatchObject({ binding: 'unbound', tabId: null, workspace: null })
  })

  it('keeps all sessions and stable ordering when live titles change', () => {
    const inputs = base()
    const rows = buildResourcePtyRows({
      ...inputs,
      sessions: [session('pty-tab'), session('other', { title: 'Setup', cwd: '/build' })]
    })
    expect(
      groupResourcePtyRows(rows).flatMap((group) =>
        group.workspaces.flatMap((workspace) => workspace.rows)
      )
    ).toHaveLength(2)
    expect(rows).toHaveLength(2)
    const changed = buildResourcePtyRows({
      ...inputs,
      runtimePaneTitlesByTabId: { tab: { 1: 'zzz live title' } }
    })
    expect(changed[0]?.sortName).toBe(rows[0]?.sortName)
  })

  it('keeps normalized project and workspace order stable across session churn', () => {
    const original = buildResourcePtyRows(base())[0]!
    const rows = [
      { ...original, projectId: 'a', project: ' Alpha ', workspaceId: 'a1', workspace: 'Main' },
      ...['1', '2', '3'].map((id) => ({
        ...original,
        identity: id,
        projectId: 'z',
        project: 'zeta',
        workspaceId: id === '1' ? 'z1' : 'z2',
        workspace: id === '1' ? 'Alpha' : 'Zeta'
      })),
      { ...original, projectId: 'b', project: 'alpha', workspaceId: 'b1', workspace: 'Main' },
      { ...original, projectId: 'z', project: 'zeta', workspaceId: 'z0', workspace: ' alpha ' }
    ]
    const order = (input: typeof rows) =>
      groupResourcePtyRows(input).map((group) => ({
        id: group.id,
        workspaces: group.workspaces.map((workspace) => workspace.id)
      }))
    const expected = [
      { id: 'a', workspaces: ['a1'] },
      { id: 'b', workspaces: ['b1'] },
      { id: 'z', workspaces: ['z0', 'z1', 'z2'] }
    ]
    expect(order(rows)).toEqual(expected)
    expect(order(rows.toReversed())).toEqual(expected)
    expect(order([...rows, ...rows.slice(0, 1), ...rows.slice(0, 1)])).toEqual(expected)
    expect(order(rows.filter((row) => row.identity !== '3'))).toEqual(expected)
  })

  it('joins and groups 1,000 sessions in memory', () => {
    const start = performance.now()
    const rows = buildResourcePtyRows({
      ...base(),
      sessions: Array.from({ length: 1_000 }, (_, index) =>
        session(`pty-${index}`, { title: `Terminal ${index}` })
      )
    })
    const groups = groupResourcePtyRows(rows)
    expect(groups[0]?.workspaces[0]?.rows).toHaveLength(1_000)
    console.info(`PTY model 1,000 rows: ${(performance.now() - start).toFixed(2)}ms`)
  })
})
