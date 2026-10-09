// Real-shaped stored partitions: the desktop's own, a relay-fallback SSH host's, a remote server's.

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../execution-host'
import { toRemoteRuntimePtyId } from '../remote-runtime-pty-id'
import { toAppSshPtyId } from '../ssh-pty-id'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf,
  SERVER_KEY,
  SSH_KEY
} from './workspace-layout-session.test-fixture'

export function sleepingRecord(
  worktreeId: string,
  tabId: string,
  leafId: string
): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:${leafId}`,
    tabId,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: 'fix the flaky test',
    state: 'done',
    capturedAt: 1_700_000_500_000,
    updatedAt: 1_700_000_500_000,
    origin: 'quit'
  }
}

/** The desktop's own partition: a git worktree split into two groups, and a folder workspace. */
export function localDesktopSession(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-a',
      recent: ['tab-shell', 'tab-agent'],
      activeTabId: 'tab-agent',
      tabs: [
        {
          id: 'tab-shell',
          leaves: [
            [leaf(1), `${GIT_KEY}@@aaaa0001`],
            [leaf(2), `${GIT_KEY}@@aaaa0002`]
          ],
          split: 'horizontal',
          layout: {
            titlesByLeafId: { [leaf(2)]: 'server' },
            scrollbackRefsByLeafId: { [leaf(1)]: 'ref-1' }
          }
        },
        {
          // Its tab-bar id and terminal id differ, as for a tab adopted from another window.
          id: 'tab-agent',
          entityId: 'term-agent',
          leaves: [[leaf(3), `${GIT_KEY}@@aaaa0003`]],
          title: 'claude',
          row: {
            defaultTitle: 'Terminal 2',
            customTitle: 'Agent',
            color: '#7c3aed',
            isPinned: true,
            viewMode: 'chat',
            launchAgent: 'claude',
            generatedTitle: 'Fix flaky test',
            generation: 2
          },
          entry: {
            label: 'claude',
            customLabel: 'Agent',
            color: '#7c3aed',
            isPinned: true,
            viewMode: 'chat',
            generatedLabel: 'Fix flaky test',
            lastFocusedAt: 1_700_000_400_000
          },
          layout: { chatLeafId: leaf(3), expandedLeafId: null }
        },
        {
          id: 'editor:src/app.ts',
          entityId: '/Users/dev/orca/src/app.ts',
          kind: 'editor',
          entry: { label: 'app.ts' }
        }
      ]
    },
    {
      id: 'group-b',
      tabs: [
        { id: 'browser-1', kind: 'browser', entry: { label: 'Docs' } },
        {
          id: 'agent-session-1',
          kind: 'agent-session',
          entry: { label: 'Codex', agentSessionAgent: 'codex' }
        },
        {
          id: 'tab-unbound',
          leaves: [[leaf(4)]],
          row: { startupCwd: '/Users/dev/orca/src', shellOverride: 'zsh' }
        }
      ]
    }
  ])
  session.openFilesByWorktree = {
    [GIT_KEY]: [
      {
        filePath: '/Users/dev/orca/src/app.ts',
        relativePath: 'src/app.ts',
        worktreeId: GIT_KEY,
        language: 'typescript',
        dirtyDraftContent: 'export {}\n',
        lastKnownDiskSignature: 'sig-1'
      }
    ]
  }
  session.browserTabsByWorktree = {
    [GIT_KEY]: [
      {
        id: 'browser-1',
        worktreeId: GIT_KEY,
        label: 'Browser 1',
        sessionProfileId: null,
        activePageId: 'page-1',
        pageIds: ['page-1'],
        url: 'https://example.com/docs',
        title: 'Docs',
        loading: false,
        faviconUrl: null,
        canGoBack: true,
        canGoForward: false,
        loadError: null,
        createdAt: 1_700_000_004_000
      }
    ]
  }
  session.browserPagesByWorkspace = {
    'browser-1': [
      {
        id: 'page-1',
        workspaceId: 'browser-1',
        worktreeId: GIT_KEY,
        url: 'https://example.com/docs',
        title: 'Docs',
        loading: false,
        faviconUrl: null,
        canGoBack: true,
        canGoForward: false,
        loadError: null,
        createdAt: 1_700_000_004_000
      }
    ]
  }
  session.activeBrowserTabIdByWorktree = { [GIT_KEY]: 'browser-1' }
  session.activeFileIdByWorktree = { [GIT_KEY]: '/Users/dev/orca/src/app.ts' }
  session.activeTabTypeByWorktree = { [GIT_KEY]: 'terminal' }
  addWorkspace(session, FOLDER_KEY, [
    {
      id: 'group-folder',
      tabs: [{ id: 'tab-notes', leaves: [[leaf(5), `${FOLDER_KEY}@@bbbb0001`]] }]
    }
  ])
  return {
    ...session,
    activeRepoId: 'repo-1',
    activeWorktreeId: GIT_KEY,
    activeWorkspaceKey: `worktree:${GIT_KEY}`,
    activeTabId: 'term-agent',
    activeWorktreeIdsOnShutdown: [GIT_KEY, FOLDER_KEY],
    localOnlyScrollbackByTabId: { 'tab-shell': { [leaf(2)]: 'last screen' } },
    lastVisitedAtByWorktreeId: {
      [GIT_KEY]: 1_700_000_400_000,
      [`local|${FOLDER_KEY}`]: 1_700_000_300_000
    },
    workspaceDocHistory: [],
    sleepingAgentSessionsByPaneKey: {
      [`term-agent:${leaf(3)}`]: sleepingRecord(GIT_KEY, 'term-agent', leaf(3))
    },
    terminalPtyIncarnationsByPaneKey: {
      [`tab-shell:${leaf(1)}`]: 'inc-1',
      [`term-agent:${leaf(3)}`]: 'inc-3'
    },
    terminalTopologyRevisionByRepoId: { 'repo-1': 7 },
    defaultTerminalTabsAppliedByWorktreeId: { [GIT_KEY]: true },
    closedTerminalTabTombstonesByTabId: {
      'tab-closed': { closedAt: 1_700_000_450_000, worktreeId: GIT_KEY, reason: 'user' }
    },
    clientHostedBrowserCloseIntentsByEnvironment: {}
  }
}

/** A relay-fallback SSH host's partition, written by the window with remote session ids. */
export function relaySshSession(targetId: string): WorkspaceSessionState {
  const pty = (n: number) => toAppSshPtyId(targetId, `pty-${n}`)
  const session = addWorkspace(
    emptySession(),
    SSH_KEY,
    [
      {
        id: 'group-ssh',
        tabs: [
          {
            id: 'tab-ssh-1',
            leaves: [
              [leaf(6), pty(1)],
              [leaf(7), pty(2)]
            ]
          },
          { id: 'tab-ssh-2', leaves: [[leaf(8), pty(3)]] }
        ]
      }
    ],
    toSshExecutionHostId(targetId)
  )
  return {
    ...session,
    remoteSessionIdsByTabId: { 'tab-ssh-1': pty(1), 'tab-ssh-2': pty(3) },
    terminalPtyIncarnationsByPaneKey: { [`tab-ssh-1:${leaf(6)}`]: 'relay-inc-1' },
    // Today's writers keep an empty revision map once created.
    terminalTopologyRevisionByRepoId: {},
    activeConnectionIdsAtShutdown: [targetId]
  }
}

/** A remote Orca server's partition (`runtime:<env>`), mirrored by the desktop. */
export function serverRuntimeSession(environmentId: string): WorkspaceSessionState {
  return addWorkspace(
    emptySession(),
    SERVER_KEY,
    [
      {
        id: 'group-server',
        tabs: [
          { id: 'tab-server', leaves: [[leaf(9), toRemoteRuntimePtyId('handle-1', environmentId)]] }
        ]
      }
    ],
    toRuntimeExecutionHostId(environmentId)
  )
}
