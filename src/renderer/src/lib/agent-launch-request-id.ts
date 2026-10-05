import { createBrowserUuid } from '@/lib/browser-uuid'

/** Names one user action that starts an agent: a click, a menu pick, a send. Minted once where that
 *  action is handled and passed down unchanged, so a re-delivery of the action (a double click, a
 *  caller retrying its own call) is the same request and every other action is a new one. */
export type AgentLaunchRequestId = string

export function newAgentLaunchRequestId(): AgentLaunchRequestId {
  return createBrowserUuid()
}
