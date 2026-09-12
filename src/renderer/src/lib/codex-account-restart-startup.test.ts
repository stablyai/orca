import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import { buildCodexAccountRestartStartup } from './codex-account-restart-startup'

let projectRuntimeContext: ProjectExecutionRuntimeResolution | undefined

vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => projectRuntimeContext
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const WORKTREE_ID = 'wt1'
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

function seedAgentStatus(entry: Record<string, unknown> | null): void {
  const paneKey = makePaneKey(TAB_ID, LEAF_ID)
  useAppStore.setState({
    agentStatusByPaneKey: entry ? { [paneKey]: { paneKey, tabId: TAB_ID, ...entry } } : {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  } as never)
}

const build = (): ReturnType<typeof buildCodexAccountRestartStartup> =>
  buildCodexAccountRestartStartup({ tabId: TAB_ID, leafId: LEAF_ID, worktreeId: WORKTREE_ID })

describe('buildCodexAccountRestartStartup', () => {
  beforeEach(() => {
    seedAgentStatus(null)
    projectRuntimeContext = undefined
  })

  it('names the session so the relaunch continues the conversation', () => {
    // Why this is load-bearing: relaunching a bare `codex` starts a brand new
    // conversation, so moving the pane's account without this loses the very
    // work the restart card promises to carry over.
    seedAgentStatus({
      agentType: 'codex',
      state: 'idle',
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
      state: 'idle',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    const startup = build()

    expect(startup.codexAccountSwitchRestart).toBe(true)
    expect(startup.launchAgent).toBe('codex')
    expect(startup.startupCommandDelivery).toBe('shell-ready')
  })

  it('falls back to a bare relaunch when the pane has no Codex session to name', () => {
    // Why not a resume argv anyway: naming a session that does not exist fails
    // the launch outright, which is worse than a fresh conversation.
    const startup = build()

    expect(startup.command).toBe('codex')
    expect(startup.resumeProviderSession).toBeUndefined()
    expect(startup.codexAccountSwitchRestart).toBe(true)
  })

  it('uses the persisted record when the live status entry is gone', () => {
    // Why: agentStatusByPaneKey does not survive an Orca restart, but the shell
    // does — and a restart in that window must still name the conversation.
    seedAgentStatus(null)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [makePaneKey(TAB_ID, LEAF_ID)]: {
          agent: 'codex',
          providerSession: { key: 'session_id', id: SESSION_ID }
        }
      }
    } as never)

    const startup = build()

    expect(startup.command).toContain(SESSION_ID)
    expect(startup.resumeProviderSession?.id).toBe(SESSION_ID)
  })

  it('keeps the bare relaunch for a resolved WSL runtime', () => {
    // Why: main repins and links the rollout for host lanes only, so a WSL
    // pane's resume argv would name a conversation its new home does not list
    // — failing the launch outright instead of at least starting clean.
    seedAgentStatus({
      agentType: 'codex',
      state: 'idle',
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
    expect(startup.codexAccountSwitchRestart).toBe(true)
  })

  it('falls back when the pane is running another agent', () => {
    seedAgentStatus({
      agentType: 'claude',
      state: 'idle',
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(build().command).toBe('codex')
  })
})
