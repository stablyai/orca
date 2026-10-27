import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import {
  makeTerminalTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { buildAgentSessionRestartStartup } from './agent-session-restart-startup'

let projectRuntimeContext: ProjectExecutionRuntimeResolution | undefined

vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => projectRuntimeContext
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const WORKTREE_ID = 'wt1'
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'
const PANE = { tabId: TAB_ID, leafId: LEAF_ID, worktreeId: WORKTREE_ID }

function seedLocalWorkspace(): void {
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: TEST_REPO.id, path: '/repo' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID, startupCwd: '/repo' })]
    },
    settings: getDefaultSettings('/home/dev')
  })
}

function seedLaunch(config?: { agentArgs?: string; agentEnv?: Record<string, string> }): void {
  useAppStore.getState().registerAgentLaunchConfig(makePaneKey(TAB_ID, LEAF_ID), {
    agentArgs: config?.agentArgs ?? '',
    agentEnv: config?.agentEnv ?? {}
  })
}

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

describe('buildAgentSessionRestartStartup', () => {
  beforeEach(() => {
    projectRuntimeContext = undefined
    seedLocalWorkspace()
    seedAgentStatus(null)
  })

  it('resumes Claude, Grok, Cursor, and Antigravity with their exact argv', () => {
    seedAgentStatus({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    seedLaunch({ agentEnv: { CLAUDE_CONFIG_DIR: '/accounts/claude' } })
    expect(buildAgentSessionRestartStartup('claude', PANE)?.command).toContain(
      `claude '--resume' '${SESSION_ID}'`
    )

    seedAgentStatus({
      agentType: 'grok',
      providerSession: { key: 'session_id', id: 'grok-session' }
    })
    seedLaunch()
    const grok = buildAgentSessionRestartStartup('grok', PANE)
    expect(grok?.command).toContain(`grok '--resume' 'grok-session'`)
    expect(grok?.resumeProviderSession).toEqual({ key: 'session_id', id: 'grok-session' })
    expect(grok?.launchAgent).toBe('grok')

    seedAgentStatus({
      agentType: 'cursor',
      providerSession: { key: 'conversation_id', id: 'conv-1' }
    })
    seedLaunch()
    expect(buildAgentSessionRestartStartup('cursor', PANE)?.command).toContain(
      `cursor-agent '--resume' 'conv-1'`
    )

    seedAgentStatus({
      agentType: 'antigravity',
      providerSession: { key: 'conversation_id', id: 'agy-1' }
    })
    seedLaunch()
    expect(buildAgentSessionRestartStartup('antigravity', PANE)?.command).toContain(
      `agy '--conversation' 'agy-1'`
    )
  })

  it('keeps recorded args and account env and drops Codex permission flags', () => {
    seedAgentStatus({
      agentType: 'codex',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    useAppStore.getState().registerAgentLaunchConfig(makePaneKey(TAB_ID, LEAF_ID), {
      agentArgs: '--dangerously-bypass-approvals-and-sandbox --model gpt',
      agentEnv: { CODEX_HOME: '/accounts/work' }
    })

    const startup = buildAgentSessionRestartStartup('codex', PANE)

    expect(startup?.command).toContain('--model')
    expect(startup?.command).toContain('gpt')
    expect(startup?.command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(startup?.command).toContain(SESSION_ID)
    expect(startup?.env?.CODEX_HOME).toBe('/accounts/work')
    expect(startup?.resumeProviderSession.id).toBe(SESSION_ID)
  })

  it('admits a Claude restart whose transcript proves the home, leaving the pin to main', () => {
    seedAgentStatus({
      agentType: 'claude',
      providerSession: {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `/accounts/A/projects/-repo/${SESSION_ID}.jsonl`
      }
    })
    seedLaunch({ agentEnv: {} })

    const startup = buildAgentSessionRestartStartup('claude', PANE)

    expect(startup?.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(startup?.command).toContain(SESSION_ID)
  })

  it('skips a Claude restart that cannot prove the original account', () => {
    seedAgentStatus({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    seedLaunch({ agentEnv: {} })

    expect(buildAgentSessionRestartStartup('claude', PANE)).toBeNull()
  })

  it('resumes a recorded default-account Codex launch that did not store CODEX_HOME', () => {
    seedAgentStatus({
      agentType: 'codex',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    seedLaunch({ agentArgs: '', agentEnv: {} })

    const startup = buildAgentSessionRestartStartup('codex', PANE)

    expect(startup?.command).toContain(SESSION_ID)
    expect(startup?.resumeOnSelectedAccount).toBe(false)
    expect(startup?.env?.CODEX_HOME).toBeUndefined()
  })

  it('skips an unrecorded launch instead of applying current command overrides', () => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/dev'),
        agentPermissionDefault: 'full-access',
        agentCmdOverrides: { claude: 'claude --dangerously-skip-permissions' },
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
      }
    })
    seedAgentStatus({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(buildAgentSessionRestartStartup('claude', PANE)).toBeNull()
  })

  it('keeps recorded args when current command overrides would add a permission bypass', () => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/dev'),
        agentCmdOverrides: { codex: 'codex --dangerously-bypass-approvals-and-sandbox' }
      }
    })
    seedAgentStatus({
      agentType: 'codex',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    seedLaunch({ agentArgs: '--model gpt', agentEnv: { CODEX_HOME: '/accounts/work' } })

    const startup = buildAgentSessionRestartStartup('codex', PANE)

    expect(startup?.command).toContain('--model')
    expect(startup?.command).toContain(SESSION_ID)
    expect(startup?.command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(startup?.env?.CODEX_HOME).toBe('/accounts/work')
  })

  it('resumes from the provider session folder when it differs from the tab folder', () => {
    seedAgentStatus({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID, cwd: '/repo/pkg' }
    })
    seedLaunch({ agentEnv: { CLAUDE_CONFIG_DIR: '/accounts/claude' } })

    expect(buildAgentSessionRestartStartup('claude', PANE)?.command).toBe(
      `cd '/repo/pkg' && claude '--resume' '${SESSION_ID}'`
    )
  })

  it('returns null instead of a bare command when the session cannot be resumed exactly', () => {
    seedAgentStatus({ agentType: 'codex', state: 'done' })
    expect(buildAgentSessionRestartStartup('codex', PANE)).toBeNull()

    seedAgentStatus({
      agentType: 'trae',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    expect(buildAgentSessionRestartStartup('trae', PANE)).toBeNull()

    seedAgentStatus({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    expect(buildAgentSessionRestartStartup('codex', PANE)).toBeNull()

    seedAgentStatus({
      agentType: 'codex',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    projectRuntimeContext = {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'repo-1:wsl:Ubuntu'
      }
    }
    expect(buildAgentSessionRestartStartup('codex', PANE)).toBeNull()
  })

  it('does not invent a local command when the workspace host is unknown or remote', () => {
    seedAgentStatus({
      agentType: 'grok',
      providerSession: { key: 'session_id', id: 'grok-session' }
    })
    useAppStore.setState({ repos: [], worktreesByRepo: {} })
    expect(buildAgentSessionRestartStartup('grok', PANE)).toBeNull()

    seedLocalWorkspace()
    seedAgentStatus({
      agentType: 'grok',
      providerSession: { key: 'session_id', id: 'grok-session' }
    })
    useAppStore.setState({
      repos: [{ ...TEST_REPO, connectionId: 'ssh-1' }]
    })
    expect(buildAgentSessionRestartStartup('grok', PANE)).toBeNull()
  })
})
