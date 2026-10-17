// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store'
import { useIdentityRowRunAccounts } from '../../store/agent-identity-row-run-accounts'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AccountAgentCount } from './AccountAgentCount'
import { countTerminalAgentsByAccount } from './count-terminal-agents-by-account'

const LEAF = '11111111-1111-4111-8111-111111111111'

function row(
  tabId: string,
  runAccount: AgentRunAccount | undefined,
  extra: Partial<AgentStatusEntry> = {}
): [string, AgentStatusEntry] {
  const paneKey = makePaneKey(tabId, LEAF)
  return [
    paneKey,
    {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey,
      stateHistory: [],
      connectionId: null,
      ...(runAccount ? { runAccount } : {}),
      ...extra
    }
  ]
}

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    worktreeId: 'wt'
  }
}

const CLAUDE_A = { provider: 'claude', lane: 'host', accountId: 'a', mode: 'follow' } as const
const ROWS = Object.fromEntries([
  row('t1', CLAUDE_A),
  row('t2', { ...CLAUDE_A, mode: 'kept' }),
  row('t3', { ...CLAUDE_A, accountId: 'b' }),
  row('t4', { provider: 'codex', lane: 'host', accountId: 'a', mode: 'follow' }),
  row('t5', { provider: 'codex', lane: 'host', accountId: null, mode: 'follow' }),
  row('t6', { ...CLAUDE_A, lane: 'wsl:Ubuntu' }),
  row('t7', CLAUDE_A, { connectionId: 'ssh-1' }),
  row('closed', CLAUDE_A),
  row('t8', undefined)
])
const TABS = { wt: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map(tab) }

describe('countTerminalAgentsByAccount', () => {
  it.each([
    ['claude', 'a', 2],
    ['claude', 'b', 1],
    ['codex', 'a', 1],
    ['codex', null, 1],
    ['claude', null, 0]
  ] as const)('counts %s agents on %s: %i', (provider, accountId, expected) => {
    expect(
      countTerminalAgentsByAccount({ rows: ROWS, tabsByWorktree: TABS, provider, accountId })
    ).toBe(expected)
  })

  it("counts by the host's identity row where it holds one, over the pane's status entry", () => {
    const identityRows = {
      // A dead terminal's agent: no status entry, only the identity row the host kept.
      [makePaneKey('t9', LEAF)]: {
        runAccount: { ...CLAUDE_A, mode: 'kept' as const },
        receivedAt: 1
      },
      // Withdrawn on the identity row; the stale status entry no longer counts.
      [makePaneKey('t1', LEAF)]: { runAccount: null, receivedAt: 1 }
    }
    const tabs = { wt: [...TABS.wt, tab('t9')] }
    const count = (keptOnly: boolean): number =>
      countTerminalAgentsByAccount({
        rows: ROWS,
        identityRows,
        tabsByWorktree: tabs,
        provider: 'claude',
        accountId: 'a',
        keptOnly
      })
    expect(count(false)).toBe(2)
    expect(count(true)).toBe(2)
  })

  it('counts nothing, rather than throwing, in a store that never loaded tabs', () => {
    expect(
      countTerminalAgentsByAccount({
        rows: ROWS,
        tabsByWorktree: undefined,
        provider: 'claude',
        accountId: 'a'
      })
    ).toBe(0)
  })
})

describe('AccountAgentCount', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ agentStatusByPaneKey: ROWS, tabsByWorktree: TABS })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useIdentityRowRunAccounts.setState({ byPaneKey: {} }, true)
  })

  it('says how many terminal agents run on the account', () => {
    expect(
      render(<AccountAgentCount provider="claude" accountId="a" enabled />).container.textContent
    ).toBe('2 terminal agents')
    cleanup()
    expect(
      render(<AccountAgentCount provider="claude" accountId="b" enabled />).container.textContent
    ).toBe('1 terminal agent')
  })

  it('counts an agent only its identity row still names', () => {
    useIdentityRowRunAccounts.setState({
      byPaneKey: { [makePaneKey('t8', LEAF)]: { runAccount: CLAUDE_A, receivedAt: 1 } }
    })
    expect(
      render(<AccountAgentCount provider="claude" accountId="a" enabled />).container.textContent
    ).toBe('3 terminal agents')
  })

  it('shows nothing at zero or for accounts this host does not run', () => {
    expect(
      render(<AccountAgentCount provider="claude" accountId={null} enabled />).container.innerHTML
    ).toBe('')
    cleanup()
    expect(
      render(<AccountAgentCount provider="claude" accountId="a" enabled={false} />).container
        .innerHTML
    ).toBe('')
  })
})
