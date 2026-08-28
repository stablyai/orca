import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { parseWorkspaceSession, workspaceSessionStateSchema } from './workspace-session-schema'
import type { WorkspaceSessionState } from './workspace-session-state-types'

/**
 * `workspaceSessionStateSchema` is the load boundary for BOTH partitions —
 * `normalize-loaded-state-collections.ts` for `local`, `workspace-session-partitions.ts` for
 * `ssh:<target>`. Zod strips unknown keys and the write side does not validate, so a field declared
 * on WorkspaceSessionState but missing here reaches disk and is silently discarded on the next
 * launch.
 *
 * That failure is invisible to any test living inside one app process, which is how the closed-tab
 * tombstone map shipped unpersisted: its unit suites, its e2e oracle and an A/B control were all
 * green, and the fix still did not survive a quit-and-relaunch.
 *
 * Two sibling tables (`profile-project-session-field-disposition.ts`,
 * `workspace-session-host-field-ownership.ts`) already pin themselves with
 * `satisfies Record<keyof WorkspaceSessionState, ...>`. This schema had no such guard and is the one
 * that fell behind, so the ratchet below is the same shape.
 */
const PERSISTED_WORKSPACE_SESSION_FIELDS = {
  activeRepoId: true,
  activeWorkspaceKey: true,
  activeWorkspaceExecutionHostId: true,
  activeWorktreeId: true,
  activeTabId: true,
  tabsByWorktree: true,
  terminalLayoutsByTabId: true,
  activeWorktreeIdsOnShutdown: true,
  openFilesByWorktree: true,
  activeFileIdByWorktree: true,
  markdownFrontmatterVisible: true,
  browserTabsByWorktree: true,
  browserPagesByWorkspace: true,
  activeBrowserTabIdByWorktree: true,
  clientHostedBrowserPagesByWorktree: true,
  clientHostedBrowserCloseIntentsByEnvironment: true,
  activeTabTypeByWorktree: true,
  browserUrlHistory: true,
  activeTabIdByWorktree: true,
  unifiedTabs: true,
  tabGroups: true,
  tabGroupLayouts: true,
  activeGroupIdByWorktree: true,
  activeConnectionIdsAtShutdown: true,
  remoteSessionIdsByTabId: true,
  lastVisitedAtByWorktreeId: true,
  defaultTerminalTabsAppliedByWorktreeId: true,
  sleepingAgentSessionsByPaneKey: true,
  terminalPtyIncarnationsByPaneKey: true,
  terminalTopologyRevisionByRepoId: true,
  terminalSurfaceTombstonesByPaneKey: true,
  closedTerminalTabTombstonesByTabId: true
} satisfies Record<keyof WorkspaceSessionState, true>

const MINIMAL_SESSION = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}

describe('workspaceSessionStateSchema field coverage', () => {
  it('parses every field declared on WorkspaceSessionState', () => {
    // The runtime half. `satisfies` above already makes a forgotten field a compile error; this
    // reports it by name, and catches the reverse case where the list is updated but the schema
    // is not.
    // Why the cast: the export is annotated `z.ZodType<WorkspaceSessionState>`, which hides
    // `.shape`. The value is a z.object; this reads its keys without widening the public type.
    const schemaKeys = new Set(
      Object.keys(
        (workspaceSessionStateSchema as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>).shape
      )
    )
    const missing = Object.keys(PERSISTED_WORKSPACE_SESSION_FIELDS).filter(
      (field) => !schemaKeys.has(field)
    )

    expect(missing, `declared on WorkspaceSessionState but absent from the load schema`).toEqual([])
  })

  it('round-trips the closed-tab tombstone map through parseWorkspaceSession', () => {
    // The regression this file exists for. Recorded on close, written to disk, stripped on the next
    // launch — so a close the transport never delivered resurrected after a quit-and-relaunch,
    // which is precisely the reported shape ("every day I open orca and it opens more tabs").
    const parsed = parseWorkspaceSession({
      ...MINIMAL_SESSION,
      closedTerminalTabTombstonesByTabId: {
        'tab-1': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1', ackRevision: 4 }
      }
    })

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1', ackRevision: 4 }
    })
  })

  it('salvages a malformed tombstone entry rather than dropping the whole map', () => {
    const parsed = parseWorkspaceSession({
      ...MINIMAL_SESSION,
      closedTerminalTabTombstonesByTabId: {
        'tab-good': { closedAt: 1, worktreeId: 'repo:wt-1' },
        'tab-bad': { closedAt: 'nope', worktreeId: 'repo:wt-1' }
      }
    })

    expect(parsed.ok).toBe(true)
    expect(
      Object.keys((parsed.ok && parsed.value.closedTerminalTabTombstonesByTabId) || {})
    ).toEqual(['tab-good'])
  })
})
