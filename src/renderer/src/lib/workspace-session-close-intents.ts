import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** The closes this client still owes runtime environments; optional for partial fixtures. */
export type CloseIntentFields = Pick<
  WorkspaceSessionState,
  'clientHostedBrowserCloseIntentsByEnvironment' | 'pairedTerminalTabCloseIntentsByEnvironment'
>

export function pickCloseIntents(snapshot: CloseIntentFields): CloseIntentFields {
  // Full writes replace the object; persist empty maps explicitly or the final cleared close-intent replay never sticks.
  return {
    clientHostedBrowserCloseIntentsByEnvironment:
      snapshot.clientHostedBrowserCloseIntentsByEnvironment,
    pairedTerminalTabCloseIntentsByEnvironment: snapshot.pairedTerminalTabCloseIntentsByEnvironment
  }
}
