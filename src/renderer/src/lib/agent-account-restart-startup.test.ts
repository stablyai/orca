import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getDefaultSettings } from '../../../shared/constants'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import {
  buildPaneAccountRestartStartup,
  resolveAgentAccountRestartResumeStartup,
  type AgentAccountRestartStartup
} from './agent-account-restart-startup'

let projectRuntimeContext: ProjectExecutionRuntimeResolution | undefined

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
  })

  it('names the session so the relaunch continues the conversation', () => {
    seedAgentStatus({
      agentType: 'codex',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    const startup = build()

    expect(startup.command).toContain('resume')
    expect(startup.command).toContain(SESSION_ID)
    expect(startup.resumeProviderSession?.id).toBe(SESSION_ID)
  })

  it('keeps the account-switch marks that make main repin the launch home', () => {
    seedAgentStatus({
      agentType: 'codex',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    const startup = build()

    expect(startup.launchAgent).toBe('codex')
    expect(startup.startupCommandDelivery).toBe('shell-ready')
  })

  it('falls back to a bare relaunch when the pane has no Codex session to name', () => {
    const startup = build()

    expect(startup.command).toBe('codex')
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('uses the persisted record when the live status entry is gone', () => {
    seedAgentStatus(null)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [makePaneKey(TAB_ID, LEAF_ID)]: {
          paneKey: makePaneKey(TAB_ID, LEAF_ID),
          worktreeId: WORKTREE_ID,
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          agent: 'codex',
          providerSession: { key: 'session_id', id: SESSION_ID }
        }
      }
    })

    const startup = build()

    expect(startup.command).toContain(SESSION_ID)
    expect(startup.resumeProviderSession?.id).toBe(SESSION_ID)
  })

  it('keeps the bare relaunch for a resolved WSL runtime', () => {
    seedAgentStatus({
      agentType: 'codex',
      state: 'done',
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

    const startup = build()

    expect(startup.command).toBe('codex')
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('falls back when the pane is running another agent', () => {
    seedAgentStatus({
      agentType: 'claude',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(build().command).toBe('codex')
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
  })

  it('resumes the pane’s Claude session with the launch marks the spawn needs', () => {
    seedAgentStatus({
      agentType: 'claude',
      state: 'waiting',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    const startup = buildPaneAccountRestartStartup('claude', pane)

    expect(startup?.command).toMatch(/^claude\b/)
    expect(startup?.command).toContain('--resume')
    expect(startup?.command).toContain(SESSION_ID)
    expect(startup?.launchAgent).toBe('claude')
    expect(startup?.startupCommandDelivery).toBe('shell-ready')
    expect(startup?.resumeProviderSession?.id).toBe(SESSION_ID)
  })

  it('resumes a hand-started Claude without the configured default arguments', () => {
    seedAgentStatus({
      agentType: 'claude',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/dev'),
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
        agentDefaultEnv: { claude: { CLAUDE_DEFAULT_ONLY: '1' } }
      }
    })

    const startup = buildPaneAccountRestartStartup('claude', pane)
    expect(startup?.command).toContain(SESSION_ID)
    expect(startup?.command).not.toContain('--dangerously-skip-permissions')
    expect(startup?.env?.CLAUDE_DEFAULT_ONLY).toBeUndefined()
  })

  it('still applies the configured default arguments to an unrecorded Codex launch', () => {
    seedAgentStatus({
      agentType: 'codex',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/dev'), agentDefaultArgs: { codex: '--search' } }
    })

    expect(buildPaneAccountRestartStartup('codex', pane)?.command).toContain('--search')
  })

  it('keeps a recorded Claude launch config on resume', () => {
    seedAgentStatus({
      agentType: 'claude',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })
    useAppStore.getState().registerAgentLaunchConfig(makePaneKey(TAB_ID, LEAF_ID), {
      agentArgs: '--model opus',
      agentEnv: {}
    })

    expect(buildPaneAccountRestartStartup('claude', pane)?.command).toContain('--model')
  })

  it('reports no resume when the Claude pane has no session id', () => {
    seedAgentStatus({ agentType: 'claude', state: 'done' })

    expect(buildPaneAccountRestartStartup('claude', pane)).toBeNull()
  })

  it('never resumes a Codex session as Claude', () => {
    seedAgentStatus({
      agentType: 'codex',
      state: 'done',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(resolveAgentAccountRestartResumeStartup('claude', pane)).toBeNull()
  })
})
