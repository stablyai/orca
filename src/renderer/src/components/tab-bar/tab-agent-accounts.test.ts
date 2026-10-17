import { describe, expect, it } from 'vitest'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type {
  ClaudeManagedAccount,
  CodexManagedAccount
} from '../../../../shared/managed-account-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { getAgentLabel } from '@/lib/agent-catalog'
import { describeTabAgentAccounts, type TabAgentAccountSettings } from './tab-agent-accounts'

const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function claudeAccount(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: '/unused',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function codexAccount(id: string, email = `${id}@example.com`): CodexManagedAccount {
  return {
    id,
    email,
    managedHomePath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const SETTINGS: TabAgentAccountSettings = {
  claudeManagedAccounts: [claudeAccount('work'), claudeAccount('personal')],
  codexManagedAccounts: [codexAccount('work')],
  activeClaudeManagedAccountId: 'work',
  activeClaudeManagedAccountIdsByRuntime: undefined,
  activeCodexManagedAccountId: 'work',
  activeCodexManagedAccountIdsByRuntime: undefined
}

function layout(leafIds: string[]): TerminalLayoutSnapshot {
  const root =
    leafIds.length === 1
      ? { type: 'leaf' as const, leafId: leafIds[0]! }
      : {
          type: 'split' as const,
          direction: 'vertical' as const,
          first: { type: 'leaf' as const, leafId: leafIds[0]! },
          second: { type: 'leaf' as const, leafId: leafIds[1]! }
        }
  return {
    root,
    activeLeafId: leafIds[0]!,
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(leafIds.map((leafId) => [leafId, `pty-${leafId}`]))
  }
}

function row(leafId: string, runAccount: AgentRunAccount, extra: Partial<AgentStatusEntry> = {}) {
  const paneKey = makePaneKey(TAB, leafId)
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: [],
    connectionId: null,
    runAccount,
    ...extra
  }
  return { [paneKey]: entry }
}

function describeOne(facet: AgentRunAccount, settings = SETTINGS) {
  return describeTabAgentAccounts({
    tabId: TAB,
    layout: layout([LEFT]),
    rows: row(LEFT, facet),
    settings
  })[0]
}

const CLAUDE = { provider: 'claude', lane: 'host' } as const
const CODEX = { provider: 'codex', lane: 'host' } as const

describe('describeTabAgentAccounts', () => {
  it.each<[string, AgentRunAccount, string, string]>([
    [
      'a kept Codex agent',
      { ...CODEX, accountId: 'work', mode: 'kept' },
      'work@example.com',
      'Kept on this account'
    ],
    [
      'a Claude agent started kept',
      { ...CLAUDE, accountId: 'personal', mode: 'kept', shellRoute: 'account' },
      'personal@example.com',
      'Kept on this account'
    ],
    [
      'a Claude agent kept after it started',
      { ...CLAUDE, accountId: 'personal', mode: 'kept', shellRoute: 'selected' },
      'personal@example.com',
      'Kept on this account from its next start'
    ],
    [
      'an agent on the selected account',
      { ...CLAUDE, accountId: 'work', mode: 'follow', shellRoute: 'selected' },
      'work@example.com',
      'Follows the selected account'
    ],
    [
      'an agent left behind on another account',
      { ...CLAUDE, accountId: 'personal', mode: 'follow', shellRoute: 'selected' },
      'personal@example.com',
      'Follows the selected account from its next start'
    ],
    [
      'an agent started on its own pointer, then released',
      { ...CLAUDE, accountId: 'work', mode: 'follow', shellRoute: 'account' },
      'work@example.com',
      'Follows the selected account from its next start'
    ],
    [
      'an agent on System default',
      { ...CODEX, accountId: null, mode: 'follow' },
      'System default',
      'Follows the selected account from its next start'
    ],
    [
      'an agent kept on an account that was removed',
      { ...CODEX, accountId: 'gone', mode: 'kept' },
      'Removed account',
      'Kept on this account'
    ]
  ])('labels %s', (_label, facet, accountLabel, note) => {
    expect(describeOne(facet)).toMatchObject({ accountLabel, note, kept: facet.mode === 'kept' })
  })

  it('tells same-email Codex accounts apart the way the switcher does', () => {
    const settings = {
      ...SETTINGS,
      codexManagedAccounts: [
        { ...codexAccount('one', 'same@example.com'), workspaceLabel: 'Team' },
        { ...codexAccount('two', 'same@example.com'), workspaceLabel: 'Personal' }
      ]
    }
    expect(
      describeOne({ ...CODEX, accountId: 'one', mode: 'follow' }, settings)?.accountLabel
    ).toBe('same@example.com (Team)')
  })

  it('lists split panes in layout order with numbered agents, and carries why Keep is off', () => {
    const accounts = describeTabAgentAccounts({
      tabId: TAB,
      layout: layout([LEFT, RIGHT]),
      rows: {
        ...row(RIGHT, { ...CLAUDE, accountId: 'work', mode: 'follow', shellRoute: 'selected' }),
        ...row(LEFT, {
          ...CLAUDE,
          accountId: 'personal',
          mode: 'follow',
          shellRoute: 'selected',
          keepUnavailable: 'no-session'
        })
      },
      settings: SETTINGS
    })
    const claude = getAgentLabel('claude')
    expect(accounts.map((account) => [account.agentLabel, account.ptyId])).toEqual([
      [`${claude} 1`, `pty-${LEFT}`],
      [`${claude} 2`, `pty-${RIGHT}`]
    ])
    expect(accounts[0]?.keepDisabledReason).toBe('no-session')
    expect(accounts[1]).not.toHaveProperty('keepDisabledReason')
  })

  it('ignores relay rows, rows without a facet and panes outside the layout', () => {
    expect(
      describeTabAgentAccounts({
        tabId: TAB,
        layout: layout([LEFT]),
        rows: {
          ...row(LEFT, { ...CODEX, accountId: 'work', mode: 'follow' }, { connectionId: 'ssh-1' }),
          ...row(RIGHT, { ...CODEX, accountId: 'work', mode: 'follow' })
        },
        settings: SETTINGS
      })
    ).toEqual([])
  })
})
