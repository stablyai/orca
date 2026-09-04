// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import { maximizeSessionGridCard } from './session-grid-card-maximize'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { SessionGridItem } from '../../../../shared/session-grid-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const SSH_HOST = 'ssh:box'
const WT_ID = 'repo-remote::/srv/checkout'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-remote', LEAF)
// The pty id carries its own owner, which is what makes the card's host authoritative.
const SSH_PTY = 'ssh:box@@pty-remote'

const initialState = useAppStore.getInitialState()

function card(overrides: Partial<SessionGridItem> = {}): SessionGridItem {
  return {
    tabId: 'tab-remote',
    ptyId: SSH_PTY,
    paneKey: PANE_KEY,
    worktreeId: WT_ID,
    repoId: 'repo-remote',
    repoName: 'remote',
    worktreeName: 'checkout',
    title: 'Agent',
    dotState: 'done',
    hasUnread: true,
    attentionBadge: 'unread',
    isHiddenFromGrid: false,
    createdAt: 1,
    hostKind: 'ssh',
    executionHostId: 'ssh:box',
    cwd: '/srv/checkout',
    shellOverride: undefined,
    launchAgent: undefined,
    ...overrides
  }
}

function focusEvents(): { readonly all: () => FocusTerminalPaneDetail[]; stop: () => void } {
  const seen: FocusTerminalPaneDetail[] = []
  const listener = (e: Event): void => {
    seen.push((e as CustomEvent<FocusTerminalPaneDetail>).detail)
  }
  window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, listener)
  return {
    all: () => seen,
    stop: () => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, listener)
  }
}

beforeEach(() => {
  // activateTabAndFocusPane defers the focus event one frame; run it inline.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // Activation reaches for the preload bridge (GitHub refresh, persistence); there is none here.
  vi.stubGlobal('api', { gh: {}, worktrees: {}, notifications: {} })
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    activeView: 'sessions',
    // The grid is cross-repo, so the card's repo is deliberately not the active one.
    activeRepoId: 'repo-local',
    activeWorktreeId: null,
    repos: [
      { id: 'repo-local', displayName: 'local', path: '/code/local' } as unknown as Repo,
      { id: 'repo-remote', displayName: 'remote', path: '/srv' } as unknown as Repo
    ],
    worktreesByRepo: {
      'repo-remote': [
        {
          id: WT_ID,
          repoId: 'repo-remote',
          path: '/srv/checkout',
          displayName: 'checkout',
          branch: 'main'
          // Deliberately NO hostId: this is the pre-host persisted row the builder
          // covers at session-grid-items-builder.test.ts ('believes the pty over a
          // workspace that never got a host stamp'). Stamping the worktree too would
          // align the two sources and let a workspace-derived host pass unnoticed.
        } as unknown as Worktree
      ]
    },
    tabsByWorktree: {
      [WT_ID]: [
        { id: 'tab-remote', ptyId: SSH_PTY, worktreeId: WT_ID, title: 'Agent', createdAt: 1 }
      ] as TerminalTab[]
    },
    ptyIdsByTabId: { 'tab-remote': [SSH_PTY] },
    terminalLayoutsByTabId: {
      'tab-remote': { root: null, activeLeafId: LEAF, expandedLeafId: null }
    } as never
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('maximizeSessionGridCard', () => {
  // The card's host comes from its pty, and the pty outranks the workspace (P5). Re-deriving
  // it from `worktreeId` answers with the workspace's host — here `local` — and every later
  // operation is routed to the wrong machine (docs/reference/ssh-execution-boundary.md).
  it('activates on the host the pty names, not the one the workspace implies', () => {
    maximizeSessionGridCard(card())

    const state = useAppStore.getState()
    expect(state.activeWorkspaceExecutionHostId).toBe(SSH_HOST)
    expect(state.activeWorktreeId).toBe(WT_ID)
    expect(state.activeView).toBe('terminal')
  })

  // The other half of the same rule: a card with no pty to ask has nothing to outrank the
  // workspace with, so the workspace's own stamp is the answer.
  it('falls back to the workspace host for a card with no pty of its own', () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-remote': [
          {
            id: WT_ID,
            repoId: 'repo-remote',
            path: '/srv/checkout',
            displayName: 'checkout',
            branch: 'main',
            hostId: 'ssh:other'
          } as unknown as Worktree
        ]
      }
    })

    maximizeSessionGridCard(card({ ptyId: null, paneKey: null, executionHostId: 'ssh:other' }))

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:other')
  })

  // The grid lists every repo at once, which the old maximize never accounted for.
  it('crosses repos, taking the active repo with it', () => {
    maximizeSessionGridCard(card())

    expect(useAppStore.getState().activeRepoId).toBe('repo-remote')
  })

  it('focuses the pane the card was previewing, and acks that turn on arrival', () => {
    const events = focusEvents()

    try {
      maximizeSessionGridCard(card())
    } finally {
      events.stop()
    }

    expect(useAppStore.getState().activeTabId).toBe('tab-remote')
    expect(events.all()).toEqual([
      {
        tabId: 'tab-remote',
        leafId: LEAF,
        ackPaneKeyOnSuccess: PANE_KEY,
        flashFocusedPane: true
      }
    ])
  })

  // A parked card has no live pane to name; the tab still has to open. Its host is the
  // workspace's — `local` here, since nothing stamped it — because there is no pty to ask.
  it('opens a card with no live pane without inventing a leaf to ack', () => {
    const events = focusEvents()

    try {
      maximizeSessionGridCard(
        card({ ptyId: null, paneKey: null, executionHostId: LOCAL_EXECUTION_HOST_ID })
      )
    } finally {
      events.stop()
    }

    expect(useAppStore.getState().activeTabId).toBe('tab-remote')
    expect(events.all()).toEqual([])
  })

  it('does nothing at all when the workspace is gone from under the card', () => {
    useAppStore.setState({ worktreesByRepo: {} })

    maximizeSessionGridCard(card())

    const state = useAppStore.getState()
    expect(state.activeView).toBe('sessions')
    expect(state.activeWorktreeId).toBeNull()
  })
})
