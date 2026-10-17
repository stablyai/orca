import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'
import { TerminalCreateParams } from './rpc-contract/terminal-unary-params'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from './rpc-contract/agent-session-params'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { ACTIVE_CLAUDE_ACCOUNT } from './claude/project-claude-account-preference'

function persistedLaunchConfig(claudeAccountId: unknown) {
  const result = parseWorkspaceSession({
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {
      'tab1:pane-1': {
        paneKey: 'tab1:pane-1',
        tabId: 'tab1',
        worktreeId: 'wt',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' },
        prompt: 'continue',
        state: 'done',
        capturedAt: 10,
        updatedAt: 10,
        launchConfig: { agentArgs: '--verbose', agentEnv: {}, claudeAccountId }
      }
    }
  })
  if (!result.ok) {
    throw new Error('workspace session did not parse')
  }
  return result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.launchConfig
}

describe('launchConfig.claudeAccountId across schema boundaries', () => {
  it('keeps a pinned id and the active sentinel in a persisted sleeping record', () => {
    expect(persistedLaunchConfig('acct-b')?.claudeAccountId).toBe('acct-b')
    expect(persistedLaunchConfig(ACTIVE_CLAUDE_ACCOUNT)?.claudeAccountId).toBe(
      ACTIVE_CLAUDE_ACCOUNT
    )
  })

  it('drops a malformed id without discarding the rest of the launch config', () => {
    expect(persistedLaunchConfig('bad\u0000id')).toEqual({ agentArgs: '--verbose', agentEnv: {} })
    expect(persistedLaunchConfig(42)).toEqual({ agentArgs: '--verbose', agentEnv: {} })
  })

  it('carries the id on terminal.create and through the resume config builder', () => {
    const parsed = TerminalCreateParams.parse({
      worktree: 'path:/repo',
      launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: ACTIVE_CLAUDE_ACCOUNT }
    })
    expect(parsed.launchConfig?.claudeAccountId).toBe(ACTIVE_CLAUDE_ACCOUNT)
    expect(buildSleepingAgentLaunchConfig({ claudeAccountId: 'acct-b' }).claudeAccountId).toBe(
      'acct-b'
    )
    expect(buildSleepingAgentLaunchConfig({ claudeAccountId: '' })).not.toHaveProperty(
      'claudeAccountId'
    )
  })

  it.each([
    [
      'terminal.createAgentSession',
      CreateAgentSessionParams,
      {
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: 'path:/repo',
        agent: 'claude'
      }
    ],
    [
      'terminal.ensureAgentSession',
      EnsureAgentSessionParams,
      {
        kind: 'explicit',
        worktree: 'path:/repo',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' }
      }
    ]
  ] as const)('keeps a valid account and strips garbage on %s', (_method, schema, base) => {
    const accountOf = (claudeAccountId: unknown) => {
      const parsed = schema.parse({ ...base, claudeAccountId })
      return 'claudeAccountId' in parsed ? parsed.claudeAccountId : undefined
    }
    expect(accountOf(ACTIVE_CLAUDE_ACCOUNT)).toBe(ACTIVE_CLAUDE_ACCOUNT)
    expect(accountOf('acct-b')).toBe('acct-b')
    expect(accountOf('bad\u0000id')).toBeUndefined()
    expect(accountOf(42)).toBeUndefined()
  })
})
