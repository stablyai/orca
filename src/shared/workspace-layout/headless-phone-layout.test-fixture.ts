// Stored partitions for comparing what a phone is sent from a host with no window against what
// the desktop window shows, one worktree per case so a fix in one cannot leak into another.

import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-legacy-profile.test-fixture'
import { addWorkspace, emptySession, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'

const A = 'repo-1::/repos/a'
const B = 'repo-1::/repos/b'
const C = 'repo-1::/repos/c'
const D = 'repo-1::/repos/d'

/** Per worktree: each terminal pane in order as `tab terminal title`, the selected tab, and each
 * tab group's tabs and selected tab. */
export type PhoneLayoutView = Record<
  string,
  { panes: string[]; active: string | null; groups: { tabs: string[]; active: string | null }[] }
>

export type HeadlessPhoneLayoutCase = {
  name: string
  build: () => WorkspaceSessionState
  /** What main sends a phone from a host with no window. */
  main: PhoneLayoutView
  /** What the desktop window shows at startup. */
  desktop: PhoneLayoutView
  /** Worktrees where the phone now shows the desktop's view; it shows main's everywhere else. */
  phoneFollowsDesktop: string[]
}

function legacyFixture(name: string): WorkspaceSessionState {
  return LEGACY_WORKSPACE_LAYOUT_PROFILES.find((profile) => profile.name === name)!.build()
}

/** A row saved before pane layouts existed, in its own worktree. */
function withLayoutlessRow(session: WorkspaceSessionState): WorkspaceSessionState {
  session.tabsByWorktree[D] = [
    {
      id: 'tab-old',
      ptyId: 'pty-old',
      worktreeId: D,
      title: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  ]
  return session
}

function contaminationSession(): WorkspaceSessionState {
  let session = emptySession()
  session = addWorkspace(session, A, [
    {
      id: 'ga',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
        { id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }
      ]
    }
  ])
  session.tabsByWorktree[A]!.push({
    ...session.tabsByWorktree[A]![0]!,
    id: 'tab-legacy',
    title: 'Terminal 3',
    sortOrder: 2,
    createdAt: 1_700_000_009_000
  })
  session.terminalLayoutsByTabId['tab-legacy'] = {
    root: { type: 'leaf', leafId: leaf(3) },
    activeLeafId: leaf(3),
    expandedLeafId: null,
    ptyIdsByLeafId: { [leaf(3)]: 'pty-a' }
  }
  session = addWorkspace(session, B, [
    {
      id: 'gb',
      tabs: [
        { id: 'tab-c', leaves: [[leaf(4), 'pty-c']] },
        { id: 'tab-d', leaves: [[leaf(5), 'pty-d']] }
      ]
    }
  ])
  session.terminalSurfaceTombstonesByPaneKey = {
    [`tab-d:${leaf(5)}`]: {
      worktreeId: B,
      parentTabId: 'tab-d',
      leafId: leaf(5),
      ptyId: 'pty-d',
      incarnationId: 'incarnation-d',
      retiredAt: 1
    }
  }
  session = addWorkspace(session, C, [
    { id: 'gc', tabs: [{ id: 'tab-e', leaves: [[leaf(6), 'pty-e']] }] }
  ])
  session.unifiedTabs![C]![0]!.label = 'vim'
  return withLayoutlessRow(session)
}

function staleRowTerminalSession(): WorkspaceSessionState {
  let session = addWorkspace(emptySession(), A, [
    {
      id: 'ga',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
        { id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }
      ]
    }
  ])
  session.tabsByWorktree[A]![0]!.ptyId = 'pty-b'
  session = addWorkspace(session, C, [
    { id: 'gc', tabs: [{ id: 'tab-e', leaves: [[leaf(6), 'pty-e']] }] }
  ])
  session.unifiedTabs![C]![0]!.label = 'vim'
  return withLayoutlessRow(session)
}

function terminalInTwoWorktreesSession(): WorkspaceSessionState {
  let session = addWorkspace(emptySession(), A, [
    { id: 'ga', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-shared']] }] }
  ])
  session = addWorkspace(session, B, [
    { id: 'gb', tabs: [{ id: 'tab-b', leaves: [[leaf(2), 'pty-shared']] }] }
  ])
  return session
}

function sshRelayDuplicateSession(): WorkspaceSessionState {
  const session = legacyFixture('legacy row repeating a tab-bar tab’s terminal')
  return JSON.parse(JSON.stringify(session).replaceAll('"pty-a"', '"ssh:target-1@@pty-1"'))
}

const oneGroup = (tabs: string[], active: string) => [{ tabs, active }]
const duplicate = {
  main: {
    panes: ['tab-a pty-a Terminal 1', 'tab-b pty-b Terminal 2', 'tab-legacy pty-a Terminal 3'],
    active: 'tab-a',
    groups: oneGroup(['tab-a', 'tab-b', 'tab-legacy'], 'tab-a')
  },
  desktop: {
    panes: ['tab-a pty-a Terminal 1', 'tab-b pty-b Terminal 2'],
    active: 'tab-a',
    groups: oneGroup(['tab-a', 'tab-b'], 'tab-a')
  }
}
const tabBarPair = (first: string, second: string) => {
  const [firstTab, secondTab] = [first.split(' ')[0]!, second.split(' ')[0]!]
  return {
    panes: [`${first} Terminal 1`, `${second} Terminal 2`],
    active: firstTab,
    groups: oneGroup([firstTab, secondTab], firstTab)
  }
}
const single = (pane: string) => {
  const tab = pane.split(' ')[0]!
  return { panes: [`${pane} Terminal 1`], active: tab, groups: oneGroup([tab], tab) }
}
const vimTab = single('tab-e pty-e')
const layoutless = {
  main: single('tab-old pty-old'),
  // The window binds a layoutless row's terminal when its pane mounts, not at startup.
  desktop: {
    panes: ['tab-old (no layout yet) Terminal 1'],
    active: null,
    groups: oneGroup(['tab-old'], 'tab-old')
  }
}
const splitRowGroups = oneGroup(['tab-a', 'tab-b', 'tab-legacy'], 'tab-a')

export const HEADLESS_PHONE_LAYOUT_CASES: readonly HeadlessPhoneLayoutCase[] = [
  {
    name: 'legacy row repeating a tab-bar tab’s terminal',
    build: () => legacyFixture('legacy row repeating a tab-bar tab’s terminal'),
    main: { [GIT_KEY]: duplicate.main },
    desktop: { [GIT_KEY]: duplicate.desktop },
    phoneFollowsDesktop: [GIT_KEY]
  },
  {
    name: 'legacy row repeating a tab-bar tab’s terminal, selected',
    build: () => legacyFixture('legacy row repeating a tab-bar tab’s terminal, selected'),
    main: {
      [GIT_KEY]: {
        ...duplicate.main,
        active: 'tab-legacy',
        groups: oneGroup(['tab-a', 'tab-b', 'tab-legacy'], 'tab-legacy')
      }
    },
    desktop: { [GIT_KEY]: duplicate.desktop },
    phoneFollowsDesktop: [GIT_KEY]
  },
  {
    name: 'legacy row repeating an SSH relay terminal with no incarnation recorded',
    build: sshRelayDuplicateSession,
    main: {
      [GIT_KEY]: {
        ...duplicate.main,
        panes: duplicate.main.panes.map((pane) => pane.replace('pty-a', 'ssh:target-1@@pty-1'))
      }
    },
    desktop: {
      [GIT_KEY]: {
        ...duplicate.desktop,
        panes: duplicate.desktop.panes.map((pane) => pane.replace('pty-a', 'ssh:target-1@@pty-1'))
      }
    },
    phoneFollowsDesktop: [GIT_KEY]
  },
  {
    // The window unbinds the repeated pane but keeps the row; the phone keeps main's view.
    name: 'legacy split row sharing one pane’s terminal with a tab-bar tab',
    build: () => legacyFixture('legacy split row sharing one pane’s terminal with a tab-bar tab'),
    main: {
      [GIT_KEY]: {
        panes: [
          'tab-a pty-a Terminal 1',
          'tab-b pty-b Terminal 2',
          'tab-legacy pty-a Terminal 3',
          'tab-legacy pty-c Terminal 3'
        ],
        active: 'tab-a',
        groups: splitRowGroups
      }
    },
    desktop: {
      [GIT_KEY]: {
        panes: [
          'tab-a pty-a Terminal 1',
          'tab-b pty-b Terminal 2',
          'tab-legacy - Terminal 3',
          'tab-legacy pty-c Terminal 3'
        ],
        active: 'tab-a',
        groups: splitRowGroups
      }
    },
    phoneFollowsDesktop: []
  },
  {
    name: 'duplicate in one worktree, with a tombstone, a label and a layoutless row in others',
    build: contaminationSession,
    main: {
      [A]: duplicate.main,
      [B]: tabBarPair('tab-c pty-c', 'tab-d pty-d'),
      [C]: vimTab,
      [D]: layoutless.main
    },
    desktop: {
      [A]: duplicate.desktop,
      [B]: tabBarPair('tab-c pty-c', 'tab-d pty-d'),
      [C]: vimTab,
      [D]: layoutless.desktop
    },
    phoneFollowsDesktop: [A]
  },
  {
    name: 'tab-bar row whose stale row terminal is another tab’s pane',
    build: staleRowTerminalSession,
    main: {
      [A]: tabBarPair('tab-a pty-a', 'tab-b pty-b'),
      [C]: vimTab,
      [D]: layoutless.main
    },
    desktop: {
      [A]: tabBarPair('tab-a pty-a', 'tab-b pty-b'),
      [C]: vimTab,
      [D]: layoutless.desktop
    },
    phoneFollowsDesktop: []
  },
  {
    name: 'one terminal in tab-bar tabs of two worktrees',
    build: terminalInTwoWorktreesSession,
    main: { [A]: single('tab-a pty-shared'), [B]: single('tab-b pty-shared') },
    desktop: { [A]: single('tab-a pty-shared'), [B]: single('tab-b pty-shared') },
    phoneFollowsDesktop: []
  }
]

export const HEADLESS_PHONE_WORKTREES = { A, B, C, D }
