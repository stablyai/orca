import { afterEach, describe, expect, it } from 'vitest'
import {
  makeTerminalTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import type { AgentSessionRestartStartup } from './agent-session-restart-startup'
import type { AgentSessionRestartPane } from './agent-session-restart-plan'
import {
  registerMountedAgentSessionRestart,
  resetMountedAgentSessionRestartsForTests
} from './agent-session-restart-mounted'
import {
  restoreUnstartedSessionRestartPane,
  spawnMountedAgentSessionRestart
} from './agent-session-restart-spawn'

const TAB_ID = 'tab-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const WORKTREE_ID = 'wt1'

function pane(): AgentSessionRestartPane {
  return {
    ptyId: 'pty-old',
    tabId: TAB_ID,
    leafId: LEAF_ID,
    worktreeId: WORKTREE_ID,
    workspaceLabel: 'repo',
    tabGeneration: 1,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    state: 'done',
    structuredHostOwned: false,
    executionHostId: 'local',
    foreignPty: false,
    wsl: false
  }
}

function startup(): AgentSessionRestartStartup {
  return {
    command: "claude '--resume' 'sess-1'",
    startupCommandDelivery: 'shell-ready',
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: 'sess-1' },
    resumeOnSelectedAccount: false
  }
}

function seedPane(generation = 1): void {
  const tab = makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: TEST_REPO.id, path: '/repo' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [{ ...tab, generation }]
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-old'] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-old' }
      }
    }
  })
}

function clearLeaf(): void {
  useAppStore.getState().clearTabPtyId(TAB_ID, 'pty-old')
  const layout = useAppStore.getState().terminalLayoutsByTabId[TAB_ID]
  if (!layout) {
    return
  }
  const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
  delete ptyIdsByLeafId[LEAF_ID]
  useAppStore.setState({
    terminalLayoutsByTabId: {
      ...useAppStore.getState().terminalLayoutsByTabId,
      [TAB_ID]: { ...layout, ptyIdsByLeafId }
    }
  })
}

afterEach(() => {
  resetMountedAgentSessionRestartsForTests()
})

describe('spawnMountedAgentSessionRestart', () => {
  it('does not restore after a post-stop failure, a closed tab, a new generation, or a new owner', async () => {
    seedPane()
    clearLeaf()
    registerMountedAgentSessionRestart('pty-old', (requested) => {
      requested?.onSessionRestartSettled?.(null)
      return true
    })
    await spawnMountedAgentSessionRestart(startup(), pane())
    expect(useAppStore.getState().ptyIdsByTabId[TAB_ID] ?? []).not.toContain('pty-old')

    seedPane()
    clearLeaf()
    useAppStore.setState({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    expect(restoreUnstartedSessionRestartPane(pane())).toBe(false)

    seedPane(4)
    clearLeaf()
    expect(restoreUnstartedSessionRestartPane(pane())).toBe(false)

    seedPane()
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-new'] },
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-new' }
        }
      }
    })
    expect(restoreUnstartedSessionRestartPane(pane())).toBe(false)
    expect(useAppStore.getState().terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'pty-new'
    )
  })
})
