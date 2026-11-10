import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-session/resume/agent-resume-launch-target'
import { makeTerminalTab } from '@/store/terminals/terminal-row.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import {
  buildPaneAccountRestartStartup,
  type AgentAccountRestartStartup
} from './agent-account-restart-startup'

let projectRuntimeContext: ProjectExecutionRuntimeResolution | undefined

vi.mock('@/lib/agent-session/resume/agent-resume-launch-target', { spy: true })

vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => projectRuntimeContext
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const WORKTREE_ID = 'wt1'
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

function seedAgentStatus(entry: Partial<AgentStatusEntry> | null): void {
  const paneKey = makePaneKey(TAB_ID, LEAF_ID)
  useAppStore.setState({
    agentStatusByPaneKey: entry
      ? {
          [paneKey]: {
            paneKey,
            tabId: TAB_ID,
            state: 'done',
            prompt: '',
            updatedAt: 1,
            stateStartedAt: 1,
            stateHistory: [],
            ...entry
          }
        }
      : {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  })
}

function build(): AgentAccountRestartStartup {
  const startup = buildPaneAccountRestartStartup('codex', {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    worktreeId: WORKTREE_ID
  })
  if (!startup) {
    throw new Error('Codex always has a restart startup')
  }
  return startup
}

describe('buildPaneAccountRestartStartup for Codex', () => {
  beforeEach(() => {
    seedAgentStatus(null)
    projectRuntimeContext = undefined
    useAppStore.setState({ settings: getDefaultSettings('/home/dev') })
  })
  it('does not resume another agent’s sleeping session when Codex has no session yet', () => {
    seedAgentStatus({ agentType: 'codex' })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [makePaneKey(TAB_ID, LEAF_ID)]: {
          paneKey: makePaneKey(TAB_ID, LEAF_ID),
          worktreeId: WORKTREE_ID,
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          agent: 'claude',
          providerSession: { key: 'session_id', id: SESSION_ID }
        }
      }
    })
    expect(build().resumeProviderSession).toBeUndefined()
  })
})

describe('buildPaneAccountRestartStartup for Claude', () => {
  const pane = { tabId: TAB_ID, leafId: LEAF_ID, worktreeId: WORKTREE_ID }

  beforeEach(() => {
    seedAgentStatus(null)
    projectRuntimeContext = undefined
    useAppStore.setState({ tabsByWorktree: {}, worktreesByRepo: {} })
  })

  it('refuses a queued restart once another live pane holds the session', () => {
    const otherTab = 'tab-other'
    const otherLeaf = '0195f2ce-2222-4000-8000-000000000002'
    const otherPaneKey = makePaneKey(otherTab, otherLeaf)
    seedAgentStatus({
      agentType: 'claude',
      state: 'waiting',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    const ownEntry = useAppStore.getState().agentStatusByPaneKey[makePaneKey(TAB_ID, LEAF_ID)]
    if (!ownEntry) {
      throw new Error('Missing seeded status')
    }
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab({ id: otherTab, worktreeId: WORKTREE_ID })]
      },
      ptyIdsByTabId: { [otherTab]: ['pty-other'] },
      terminalLayoutsByTabId: {
        [otherTab]: {
          root: { type: 'leaf', leafId: otherLeaf },
          activeLeafId: otherLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [otherLeaf]: 'pty-other' }
        }
      },
      agentStatusByPaneKey: {
        [makePaneKey(TAB_ID, LEAF_ID)]: ownEntry,
        [otherPaneKey]: { ...ownEntry, paneKey: otherPaneKey, tabId: otherTab }
      }
    })

    expect(buildPaneAccountRestartStartup('claude', pane)).toBeNull()
  })

  it.each([
    ['workspace folder', undefined, "cd '/recorded/session' && "],
    ['saved tab folder', '/recorded/session', '']
  ] as const)('uses the selected host and respects the %s on resume', (_, startupCwd, prefix) => {
    const original = useAppStore.getState()
    try {
      seedAgentStatus({
        agentType: 'claude',
        state: 'done',
        providerSession: { key: 'session_id', id: SESSION_ID, cwd: '/recorded/session' }
      })
      useAppStore.setState({
        repos: [
          TEST_REPO,
          { ...TEST_REPO, executionHostId: 'runtime:remote-host', connectionId: 'selected-ssh' }
        ],
        worktreesByRepo: {
          [TEST_REPO.id]: [
            makeWorktree({
              id: WORKTREE_ID,
              repoId: TEST_REPO.id,
              path: '/recorded/session',
              hostId: 'local'
            }),
            makeWorktree({
              id: WORKTREE_ID,
              repoId: TEST_REPO.id,
              path: '/remote/workspace',
              hostId: 'runtime:remote-host'
            })
          ]
        },
        detectedWorktreesByRepo: {},
        activeWorktreeId: WORKTREE_ID,
        activeWorkspaceExecutionHostId: 'runtime:remote-host',
        tabsByWorktree: {
          [WORKTREE_ID]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID, startupCwd })]
        }
      })

      expect(buildPaneAccountRestartStartup('claude', pane)?.command).toBe(
        `${prefix}claude '--resume' '${SESSION_ID}'`
      )
      expect(resolveAgentResumeLaunchTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionHostId: 'runtime:remote-host',
          connectionId: 'selected-ssh'
        })
      )
    } finally {
      useAppStore.setState(original)
    }
  })
})
