import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  selectNativeChatPaneConnectionId,
  selectNativeChatRuntimeEnvironmentId,
  type NativeChatPaneConnectionState,
  type NativeChatRuntimeOwnerState
} from './native-chat-runtime-owner'

type OwnerState = NativeChatRuntimeOwnerState & NativeChatPaneConnectionState

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/** A worktree record with a host id but deliberately no `path` — the owner
 *  selector must not depend on path resolution (KTD-1). `null` models a row
 *  carrying no host stamp of its own, so ownership falls to the repo. */
function worktreeRecord(hostId: string | null): OwnerState['worktreesByRepo'] {
  return { repo: [{ id: 'wt-1', repoId: 'repo', ...(hostId ? { hostId } : {}) } as never] }
}

function state(overrides: Partial<OwnerState> = {}): OwnerState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab()] },
    worktreesByRepo: worktreeRecord('local'),
    ...overrides
  } as OwnerState
}

describe('selectNativeChatRuntimeEnvironmentId', () => {
  it('returns null for a local-owned worktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state(), 'tab-1')).toBeNull()
  })

  it('returns the decoded environment id for a runtime-owned worktree', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })

  it('returns null for an ssh-connection worktree (Model A stays local)', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('ssh:conn-1') }),
        'tab-1'
      )
    ).toBeNull()
  })

  it('returns null when the terminal tab matches no tab in tabsByWorktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state({ tabsByWorktree: {} }), 'tab-1')).toBeNull()
  })

  it('returns the owner id even when the worktree record has no resolvable path', () => {
    // Guards KTD-1: no `path` on the worktree record and no getKnownWorktreeById —
    // the selector must still resolve the runtime owner from the host mapping alone.
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })
})

/** Repo catalog rows. Ownership walks the same specificity ladder the rest of
 *  the app uses — the worktree's own `hostId`, then the repo's
 *  `executionHostId`, then its legacy `connectionId` — so a repo row alone
 *  never overrules a host-stamped worktree. */
function repoRecord(
  overrides: Partial<{ connectionId: string | null; executionHostId: string | null }> = {}
): OwnerState['repos'] {
  return [{ id: 'repo', connectionId: null, executionHostId: null, ...overrides } as never]
}

describe('selectNativeChatPaneConnectionId', () => {
  it('returns null for a repo this client owns', () => {
    expect(selectNativeChatPaneConnectionId(state({ repos: repoRecord() }), 'tab-1')).toBeNull()
  })

  it('returns the ssh target id for a Model-A remote repo', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({
          repos: repoRecord({ connectionId: 'target-1' }),
          worktreesByRepo: worktreeRecord(null)
        }),
        'tab-1'
      )
    ).toBe('target-1')
  })

  // The worktree's host stamp is the authoritative owner: an SSH worktree and a
  // local checkout of the same repo share one catalog row, so reading only the
  // repo's connectionId classifies the remote pane as local and lets the local
  // session scan run against a remote cwd.
  it('returns the ssh target from the worktree host stamp when the repo row says local', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({
          repos: repoRecord({ executionHostId: 'local' }),
          worktreesByRepo: worktreeRecord('ssh:target-1')
        }),
        'tab-1'
      )
    ).toBe('target-1')
  })

  it('returns the ssh target from the repo execution host when the worktree carries no stamp', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({
          repos: repoRecord({ executionHostId: 'ssh:target-2' }),
          worktreesByRepo: worktreeRecord(null)
        }),
        'tab-1'
      )
    ).toBe('target-2')
  })

  // A runtime-owned pane is not this client's to execute either; the fail-closed
  // answer is "unknown", never "local".
  it('never reports a runtime-owned worktree as owned by this client', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({ repos: repoRecord(), worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBeUndefined()
  })

  it('returns undefined while the backing repo has not hydrated', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({ repos: [], worktreesByRepo: worktreeRecord(null) }),
        'tab-1'
      )
    ).toBeUndefined()
  })

  // A restored SSH worktree can collide with a local repo row mid-catalog-load,
  // so the local repo row is only believable once the worktree itself hydrates.
  it('returns undefined while the worktree row has not hydrated', () => {
    expect(
      selectNativeChatPaneConnectionId(
        state({ repos: repoRecord({ executionHostId: 'local' }), worktreesByRepo: {} }),
        'tab-1'
      )
    ).toBeUndefined()
  })

  // Unknown tab is "we could not ask", not "local": collapsing it to null would
  // let a remote pane pass the locality gate during a store rehydrate.
  it('returns undefined — never null — when the terminal tab maps to no worktree', () => {
    expect(
      selectNativeChatPaneConnectionId(state({ repos: repoRecord(), tabsByWorktree: {} }), 'tab-1')
    ).toBeUndefined()
  })
})
