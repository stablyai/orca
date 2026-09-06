// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchSessionGridTab } from './session-grid-launch-actions'
import { installAgentIdleWorkingHandlers } from '@/components/terminal-pane/pty-connection/agent-idle-working-handlers'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/**
 * "Launch in background" means the grid stays where it is. Against mocks that is trivially
 * true and says nothing: `createTab` activates by default and moves the GLOBAL `activeTabId`,
 * and the agent route also calls `setActiveTabType('terminal')` on whatever workspace is
 * active — which is not the launch target. So these run against the real store, and watch the
 * foreground the user comes back to, not just `activeWorktreeId`.
 */
const ACTIVE_WT = 'repo-1::/code/active'
const TARGET_WT = 'repo-1::/code/target'

const initialState = useAppStore.getInitialState()

function foreground(): {
  activeTabId: string | null
  activeTabType: string
  activeWorktreeId: string | null
  activeWorkspaceTab: string | null
} {
  const state = useAppStore.getState()
  return {
    activeTabId: state.activeTabId,
    activeTabType: state.activeTabType,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceTab: state.activeTabIdByWorktree[ACTIVE_WT] ?? null
  }
}

function targetTabIds(): string[] {
  return (useAppStore.getState().tabsByWorktree[TARGET_WT] ?? []).map((tab) => tab.id)
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [
        { id: ACTIVE_WT, repoId: 'repo-1', path: '/code/active' } as unknown as Worktree,
        { id: TARGET_WT, repoId: 'repo-1', path: '/code/target' } as unknown as Worktree
      ]
    },
    tabsByWorktree: {
      [ACTIVE_WT]: [
        { id: 'tab-open', ptyId: 'pty-open', worktreeId: ACTIVE_WT, title: 'One', createdAt: 1 }
      ] as TerminalTab[]
    },
    activeView: 'sessions',
    activeWorktreeId: ACTIVE_WT,
    activeTabId: 'tab-open',
    // The editor the user left open: the foreground the agent route used to overwrite.
    activeTabType: 'editor',
    activeTabIdByWorktree: { [ACTIVE_WT]: 'tab-open' }
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('launching from the session grid', () => {
  it.each(
    (['shell', 'agent'] as const).flatMap((kind) => [
      {
        kind,
        host: 'ssh:chosen-host' as ExecutionHostId,
        runtime: null,
        connection: 'chosen-host'
      },
      { kind, host: 'local' as ExecutionHostId, runtime: null, connection: null },
      ...(kind === 'shell'
        ? [
            { kind, host: 'runtime:hub' as ExecutionHostId, runtime: 'hub', connection: null },
            { kind, host: 'ssh:chosen-host' as ExecutionHostId, runtime: 'hub', connection: null }
          ]
        : [])
    ])
  )(
    'keeps $host through $kind pane connection (runtime $runtime)',
    ({ kind, host, runtime, connection }) => {
      const state = useAppStore.getState()
      const target = state.worktreesByRepo['repo-1'].find((wt) => wt.id === TARGET_WT)!
      useAppStore.setState({
        worktreesByRepo: {
          'repo-1': [
            ...state.worktreesByRepo['repo-1'].filter((wt) => wt.id !== TARGET_WT),
            { ...target, hostId: 'local' },
            {
              ...target,
              hostId: 'ssh:chosen-host',
              ...(runtime && host === 'ssh:chosen-host'
                ? { runtimeOwnerEnvironmentId: runtime }
                : {})
            },
            { ...target, hostId: 'runtime:hub', runtimeOwnerEnvironmentId: 'hub' }
          ]
        },
        repos: [
          ...state.repos,
          { ...state.repos[0], connectionId: 'chosen-host', executionHostId: 'ssh:chosen-host' }
        ]
      })
      if (kind === 'shell') {
        launchSessionGridTab(TARGET_WT, host)
      } else {
        launchAgentInNewTab({
          agent: 'claude',
          worktreeId: TARGET_WT,
          executionHostId: host,
          activate: false
        })
      }
      const tabId = targetTabIds()[0]
      expect(tabId).toBeTruthy()
      // Foreground changes before the staged pane mounts must not retarget the launch.
      useAppStore.setState({
        activeWorktreeId: TARGET_WT,
        activeWorkspaceExecutionHostId: host === 'local' ? 'ssh:chosen-host' : 'local'
      })
      const session = {
        deps: { tabId, worktreeId: TARGET_WT },
        cacheKey: `${tabId}:pane`
      } as unknown as ConnectPanePtySession
      installAgentIdleWorkingHandlers(session)
      expect(session.terminalOwnerUnresolved).toBe(false)
      expect(session.connectionId).toBe(connection)
      expect(session.runtimeEnvironmentId).toBe(runtime)
      expect(session.worktree?.hostId).toBe(host)
    }
  )

  it('opens a shell in another workspace without moving the foreground', () => {
    const before = foreground()

    launchSessionGridTab(TARGET_WT)

    expect(targetTabIds()).toHaveLength(1)
    expect(foreground()).toEqual(before)
  })

  it('opens an agent in another workspace without moving the foreground', () => {
    const before = foreground()

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: TARGET_WT,
      activate: false,
      launchSource: 'session_grid'
    })

    expect(result?.tabId).toBeTruthy()
    expect(targetTabIds()).toEqual([result!.tabId])
    expect(foreground()).toEqual(before)
  })

  // The tab bar's `+` is the other caller, and it still hands focus to what it just opened.
  it('still activates for a caller that did not ask to stay put', () => {
    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: TARGET_WT })

    expect(useAppStore.getState().activeTabId).toBe(result?.tabId)
    expect(useAppStore.getState().activeTabType).toBe('terminal')
  })
})
