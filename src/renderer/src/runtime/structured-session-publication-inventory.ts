import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { refreshLocalStructuredSessionTabs } from './local-structured-session-tabs-sync'
import {
  callStructuredAgentSessionForOwner,
  type StructuredAgentSessionOwner
} from './structured-agent-session-owner'

/**
 * The tab inventory a launch checks its own publication against, read from the host that owns it.
 *
 * A peer's census is only read: the peer mirror's own subscriptions are what apply its snapshots,
 * and the local applier discards every worktree it does not execute, so applying one here would
 * throw the answer away and report the session unpublished.
 */
export async function listStructuredSessionTabsForOwner(
  owner: StructuredAgentSessionOwner
): Promise<RuntimeMobileSessionTabsResult[]> {
  if (owner.kind === 'local') {
    return refreshLocalStructuredSessionTabs()
  }
  const result = await callStructuredAgentSessionForOwner<{
    snapshots?: RuntimeMobileSessionTabsResult[]
  }>(owner, 'session.tabs.listAll', {})
  return result.snapshots ?? []
}
