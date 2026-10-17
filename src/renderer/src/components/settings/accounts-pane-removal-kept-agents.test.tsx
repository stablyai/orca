// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { useIdentityRowRunAccounts } from '../../store/agent-identity-row-run-accounts'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AccountsPaneSectionModel, RemoveAccountTarget } from './accounts-pane-types'
import { renderAccountsRemovalDialogs } from './accounts-pane-removal-dialogs'

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  removeClaudeProviderAccount: vi.fn(),
  removeCodexProviderAccount: vi.fn()
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

function row(tabId: string, runAccount: AgentRunAccount): [string, AgentStatusEntry] {
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
      runAccount
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

const HOST_TARGET: RemoveAccountTarget = { id: 'work', runtime: { runtime: 'host' } }
const SENTENCE = /terminal agents? (is|are) kept on this account/

function Dialogs(props: {
  codex?: RemoveAccountTarget | null
  claude?: RemoveAccountTarget | null
  remote?: boolean
}): React.JSX.Element {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialogs read only these model members.
  const model = {
    runClaudeAccountAction: vi.fn(),
    runCodexAccountAction: vi.fn(),
    setRemoveClaudeTarget: vi.fn(),
    setRemoveCodexTarget: vi.fn(),
    accountOwner: props.remote ? { kind: 'environment', environmentId: 'env-1' } : { kind: 'local' }
  } as unknown as AccountsPaneSectionModel
  return renderAccountsRemovalDialogs(model, props.codex ?? null, props.claude ?? null)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey: Object.fromEntries([
      row('t1', { provider: 'codex', lane: 'host', accountId: 'work', mode: 'kept' }),
      row('t2', { provider: 'codex', lane: 'host', accountId: 'work', mode: 'follow' }),
      row('t3', { provider: 'claude', lane: 'host', accountId: 'work', mode: 'kept' }),
      row('t4', { provider: 'claude', lane: 'host', accountId: 'work', mode: 'kept' })
    ]),
    tabsByWorktree: { wt: ['t1', 't2', 't3', 't4'].map(tab) }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useIdentityRowRunAccounts.setState({ byPaneKey: {} }, true)
})

describe('removing an account with agents kept on it', () => {
  it('says one kept Codex agent will follow the selection, not the unkept one', () => {
    render(<Dialogs codex={HOST_TARGET} />)
    expect(
      screen.getByText(
        '1 terminal agent is kept on this account. After removal it follows the selected account from its next start.'
      )
    ).toBeTruthy()
  })

  it('counts kept Claude agents, and says claude typed in their terminals will not run', () => {
    render(<Dialogs claude={HOST_TARGET} />)
    expect(
      screen.getByText(
        '2 terminal agents are kept on this account. After removal, Orca starts them on the selected account, but claude typed in their open terminals will not run.'
      )
    ).toBeTruthy()
  })

  it('counts a kept agent whose terminal died, which only its identity row still names', () => {
    useAppStore.setState({ tabsByWorktree: { wt: ['t1', 't2', 't3', 't4', 't5'].map(tab) } })
    useIdentityRowRunAccounts.setState({
      byPaneKey: {
        [makePaneKey('t5', LEAF)]: {
          runAccount: { provider: 'codex', lane: 'host', accountId: 'work', mode: 'kept' },
          receivedAt: 1
        }
      }
    })
    render(<Dialogs codex={HOST_TARGET} />)
    expect(
      screen.getByText(
        '2 terminal agents are kept on this account. After removal they follow the selected account from their next start.'
      )
    ).toBeTruthy()
  })

  it('says nothing for an account nothing is kept on, or one this host does not run', () => {
    render(<Dialogs codex={{ id: 'other', runtime: { runtime: 'host' } }} />)
    expect(screen.queryByText(SENTENCE)).toBeNull()
    cleanup()
    render(<Dialogs codex={HOST_TARGET} remote />)
    expect(screen.queryByText(SENTENCE)).toBeNull()
    cleanup()
    render(<Dialogs codex={{ id: 'work', runtime: { runtime: 'wsl', wslDistro: 'Ubuntu' } }} />)
    expect(screen.queryByText(SENTENCE)).toBeNull()
  })
})
