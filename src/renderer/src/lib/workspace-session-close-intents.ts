import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** The closes this client still owes runtime environments; optional for partial fixtures. */
export type CloseIntentFields = Pick<
  WorkspaceSessionState,
  'clientHostedBrowserCloseIntentsByEnvironment' | 'pairedTerminalTabCloseIntentsByEnvironment'
>

export function pickCloseIntents(snapshot: CloseIntentFields): CloseIntentFields {
  // Why unconditional rather than omit-when-empty: a full write replaces the persisted object,
  // so an emptied map has to be written as empty or the last replay never sticks.
  return {
    clientHostedBrowserCloseIntentsByEnvironment:
      snapshot.clientHostedBrowserCloseIntentsByEnvironment,
    pairedTerminalTabCloseIntentsByEnvironment: snapshot.pairedTerminalTabCloseIntentsByEnvironment
  }
}
