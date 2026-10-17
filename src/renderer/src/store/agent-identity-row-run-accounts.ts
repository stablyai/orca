import { create } from 'zustand'
import {
  agentRunAccountsEqual,
  readAgentRunAccount,
  type AgentRunAccount
} from '../../../shared/agent-run-account'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../../shared/agent-status-types'

type IdentityRowRunAccount = {
  /** `null`: the host's identity row names no account (none, withdrawn, or not a local pane). */
  runAccount: AgentRunAccount | null
  receivedAt: number
}

export type IdentityRowRunAccounts = Readonly<Record<string, IdentityRowRunAccount>>

type IdentityRowRunAccountState = { byPaneKey: IdentityRowRunAccounts }

// Why a standalone store: an identity row (`providerSessionOnly`) never becomes a status entry —
// every one but Pi's is dropped — yet once a kept agent's terminal is gone it is the only row
// carrying the agent's account, and un-keeping that agent from the tab menu has to see it.
export const useIdentityRowRunAccounts = create<IdentityRowRunAccountState>()(() => ({
  byPaneKey: {}
}))

const EMPTY: IdentityRowRunAccounts = {}

function setEntry(paneKey: string, entry: IdentityRowRunAccount | undefined): void {
  useIdentityRowRunAccounts.setState((state) => {
    const next = { ...state.byPaneKey }
    if (entry) {
      next[paneKey] = entry
    } else {
      delete next[paneKey]
    }
    return { byPaneKey: next }
  })
}

/** Mirrors which kind of row the host holds for a pane: an identity row records its facet, and a
 *  status row that is not older takes the pane back, so its own facet is the one shown. */
export function noteHostRowRunAccount(
  paneKey: string,
  data: Pick<AgentStatusIpcPayload, 'providerSessionOnly' | 'connectionId' | 'runAccount'> & {
    receivedAt: number
  }
): void {
  const current = useIdentityRowRunAccounts.getState().byPaneKey[paneKey]
  if (current && data.receivedAt < current.receivedAt) {
    return
  }
  if (!data.providerSessionOnly) {
    if (current) {
      setEntry(paneKey, undefined)
    }
    return
  }
  // Why local only: a remote host's accounts are not this machine's to name.
  const runAccount = data.connectionId ? null : (readAgentRunAccount(data.runAccount) ?? null)
  if (
    current &&
    current.receivedAt === data.receivedAt &&
    agentRunAccountsEqual(current.runAccount, runAccount)
  ) {
    return
  }
  setEntry(paneKey, { runAccount, receivedAt: data.receivedAt })
}

/** The host cleared the pane's row; a retirement that keeps its identity restates the facet after. */
export function forgetIdentityRowRunAccount(paneKey: string): void {
  if (useIdentityRowRunAccounts.getState().byPaneKey[paneKey]) {
    setEntry(paneKey, undefined)
  }
}

/** The facet of the host's current row for a local pane: its identity row's when it holds one. */
export function resolvePaneRunAccount(
  paneKey: string,
  row: AgentStatusEntry | undefined,
  identityRows: IdentityRowRunAccounts = EMPTY
): AgentRunAccount | undefined {
  const identity = identityRows[paneKey]
  if (identity) {
    return identity.runAccount ?? undefined
  }
  return row && !row.connectionId ? row.runAccount : undefined
}

/** Whether the host says a restart would resume this local pane's agent on a kept account, not
 *  the selection: it is kept on the account it runs on, or its conversation is kept on another. */
export function isPaneAgentResumePinned(
  paneKey: string,
  row: AgentStatusEntry | undefined
): boolean {
  const facet = resolvePaneRunAccount(paneKey, row, useIdentityRowRunAccounts.getState().byPaneKey)
  return facet?.mode === 'kept' || facet?.keptElsewhere === true
}
