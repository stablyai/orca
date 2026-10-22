import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../execution-host'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import { worktreeIdentityKey } from '../worktree/id'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import { isIdleWorkspaceActivity, type WorkspaceActivityFacts } from './workspace-activity-facts'
import type { WorkspaceLifecycleHint } from './workspace-lifecycle-hints'

/**
 * The host whose queue key carries this copy's sleep hint: the row's own host, else its repo's
 * owner, else local, as main keys a workspace that names no host. The card and Hide sleeping
 * both read it, so a hostless workspace's glyph and filter cannot disagree.
 */
export function sleepHintHostId(
  worktree: Pick<Worktree, 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): ExecutionHostId {
  return getWorktreeExecutionHostId(worktree, repo, LOCAL_EXECUTION_HOST_ID)
}

/** The lifecycle hint main publishes for one host's copy of a workspace. */
export function feedLifecycleHint(
  inProgress: SidebarFeedDomains['inProgress'],
  worktreeId: string,
  executionHostId: ExecutionHostId | null
): WorkspaceLifecycleHint | undefined {
  return executionHostId
    ? inProgress.get(composeWorktreeHostIdentity(executionHostId, worktreeIdentityKey(worktreeId)))
    : undefined
}

/**
 * Whether a workspace reads asleep, for both the sleeping glyph and Hide sleeping, on every client
 * of main's feed. A sleep main is running counts from the moment it is requested; one its host
 * could not confirm (the queue's pause) never does. Otherwise asleep is idle: no live or
 * unverifiable terminal, browser, chat or agent, and not held through a rebind gap.
 */
export function isWorkspaceAsleep(facts: {
  hint: WorkspaceLifecycleHint | undefined
  retained: boolean
  activity: WorkspaceActivityFacts | undefined
}): boolean {
  if (facts.hint?.paused) {
    return false
  }
  if (facts.hint?.kind === 'sleep') {
    return true
  }
  return !facts.retained && (!facts.activity || isIdleWorkspaceActivity(facts.activity))
}

/**
 * How main's sleep of this host's copy of a workspace overrides what its activity says: true while
 * one runs, false while one went unconfirmed, undefined when none is in flight. A twin on another
 * host has its own key, so sleeping one copy never hides the other.
 */
export function feedSleepOverride(
  inProgress: SidebarFeedDomains['inProgress'],
  worktreeId: string,
  executionHostId: ExecutionHostId | null
): boolean | undefined {
  const hint = feedLifecycleHint(inProgress, worktreeId, executionHostId)
  if (hint?.paused) {
    return false
  }
  return hint?.kind === 'sleep' ? true : undefined
}

/** Hide sleeping's verdict for one listed row, from main's feed: the card reads the same rule. */
export function isFeedWorkspaceAsleep(
  domains: Pick<SidebarFeedDomains, 'inProgress' | 'activity'>,
  retained: ReadonlySet<string>,
  worktree: Pick<Worktree, 'id' | 'hostId' | 'repoId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): boolean {
  const identity = getWorktreeHostIdentity(worktree)
  return isWorkspaceAsleep({
    hint: feedLifecycleHint(domains.inProgress, worktree.id, sleepHintHostId(worktree, repo)),
    retained: retained.has(identity),
    activity: domains.activity.get(identity)
  })
}
