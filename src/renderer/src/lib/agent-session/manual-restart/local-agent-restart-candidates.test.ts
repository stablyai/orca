import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { makeTerminalTab } from '@/store/terminals/testing/terminal-row.test-fixture'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { localAgentRestartCandidates } from './local-agent-restart-candidates'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { ClaudeManagedAccount } from '../../../../../shared/agent-accounts/managed-account-types'

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const PTY_ID = 'pty-1'
const SESSION = { key: 'session_id', id: '01a006a6-1d07-70a1-bad5-f9110d5845c0' } as const
const LEFT_FOLDER = '/data/claude-accounts/acct-left'
const SELECTED_FOLDER = '/data/claude-accounts/acct-selected'

function claudeAccount(id: string, managedAuthPath: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

const transcriptUnder = (folder: string): string => `${folder}/projects/-repo/${SESSION.id}.jsonl`

const get = () => useAppStore.getState()

function seedPane(pane: {
  agentType: 'codex' | 'claude'
  providerSession: AgentStatusEntry['providerSession']
  /** What the pane's process table shows in front. */
  foreground: string
  restoredUnconfirmed?: true
}): void {
  const paneKey = makePaneKey(TAB_ID, LEAF_ID)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      claudeManagedAccounts: [
        claudeAccount('acct-left', LEFT_FOLDER),
        claudeAccount('acct-selected', SELECTED_FOLDER)
      ],
      activeClaudeManagedAccountId: 'acct-selected'
    },
    tabsByWorktree: { wt1: [makeTerminalTab({ id: TAB_ID, worktreeId: 'wt1' })] },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        paneKey,
        {
          paneKey,
          tabId: TAB_ID,
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: pane.agentType,
          ...(pane.providerSession ? { providerSession: pane.providerSession } : {}),
          ...(pane.restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
        }
      ]
    ]),
    paneForegroundAgentByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    codexRestartNoticeByPtyId: {}
  })
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: pane.foreground,
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue(pane.foreground)
}

describe('localAgentRestartCandidates', () => {
  beforeEach(() => {
    vi.mocked(inspectRuntimeTerminalProcess).mockReset()
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubClaudeAccountsList(): void {
    vi.stubGlobal('window', {
      api: { claudeAccounts: { list: async () => ({ accounts: [], activeAccountId: null }) } }
    })
  }

  it('lists a running Codex pane without a session as not restartable', async () => {
    seedPane({ agentType: 'codex', providerSession: undefined, foreground: 'codex' })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: false, reason: 'no-session' }
    ])
  })

  it('checks a finished Codex session by default', async () => {
    seedPane({ agentType: 'codex', providerSession: SESSION, foreground: 'codex' })
    expect(await localAgentRestartCandidates(get())).toEqual([
      {
        ptyId: PTY_ID,
        worktreeId: 'wt1',
        tabId: TAB_ID,
        leafId: LEAF_ID,
        agent: 'codex',
        restartable: true,
        quiet: true
      }
    ])
  })

  it('leaves out a pane whose agent has exited to the shell', async () => {
    seedPane({ agentType: 'codex', providerSession: SESSION, foreground: 'zsh' })
    expect(await localAgentRestartCandidates(get())).toEqual([])
  })

  it('keeps a Codex pane that an account switch asked to restart on its own account', async () => {
    seedPane({ agentType: 'codex', providerSession: SESSION, foreground: 'codex' })
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ID]: { previousAccountLabel: 'Work', nextAccountLabel: 'Personal', dismissed: true }
      }
    })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: false, reason: 'other-account' }
    ])
  })

  it('leaves a restored row unchecked until its status is confirmed', async () => {
    seedPane({
      agentType: 'codex',
      providerSession: SESSION,
      foreground: 'codex',
      restoredUnconfirmed: true
    })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: true, quiet: false }
    ])
  })

  it('leaves a session unchecked when its turn starts while the scan waits', async () => {
    seedPane({ agentType: 'codex', providerSession: SESSION, foreground: 'codex' })
    const paneKey = makePaneKey(TAB_ID, LEAF_ID)
    const row = get().agentStatusByPaneKey.get(paneKey)!
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: acceptedAgentStatuses([[paneKey, { ...row, state: 'working' }]])
      })
      return { foregroundProcess: 'codex', hasChildProcesses: true }
    })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: true, quiet: false }
    ])
  })

  it('keeps a Claude session that runs on an account other than the selected one', async () => {
    stubClaudeAccountsList()
    seedPane({
      agentType: 'claude',
      providerSession: { ...SESSION, transcriptPath: transcriptUnder(LEFT_FOLDER) },
      foreground: 'claude'
    })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: false, reason: 'other-account' }
    ])
  })

  it('keeps a Claude session whose account folder is unknown', async () => {
    stubClaudeAccountsList()
    seedPane({ agentType: 'claude', providerSession: SESSION, foreground: 'claude' })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: false, reason: 'couldnt-check' }
    ])
  })

  it("keeps a Claude session when the host's account folders cannot be read", async () => {
    vi.stubGlobal('window', {
      api: { claudeAccounts: { list: () => Promise.reject(new Error('main unavailable')) } }
    })
    seedPane({
      agentType: 'claude',
      providerSession: { ...SESSION, transcriptPath: transcriptUnder(SELECTED_FOLDER) },
      foreground: 'claude'
    })
    expect(await localAgentRestartCandidates(get())).toMatchObject([
      { restartable: false, reason: 'couldnt-check' }
    ])
  })
})
