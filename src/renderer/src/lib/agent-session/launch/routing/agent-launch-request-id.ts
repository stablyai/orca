import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'

/** Mint once per user action and preserve through re-entry; separate clicks, including a double click, get distinct request IDs. */
export type AgentLaunchRequestId = string

export function newAgentLaunchRequestId(): AgentLaunchRequestId {
  return createBrowserUuid()
}
