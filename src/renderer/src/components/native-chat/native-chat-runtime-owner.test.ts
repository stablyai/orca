import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import {
  selectNativeChatRuntimeEnvironmentId,
  type NativeChatRuntimeOwnerState
} from './native-chat-runtime-owner'

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
 *  selector must not depend on path resolution (KTD-1). */
function worktreeRecord(hostId: string): NativeChatRuntimeOwnerState['worktreesByRepo'] {
  return { repo: [{ id: 'wt-1', repoId: 'repo', hostId } as never] }
}

function state(overrides: Partial<NativeChatRuntimeOwnerState> = {}): NativeChatRuntimeOwnerState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab()] },
    worktreesByRepo: worktreeRecord('local'),
    ...overrides
  } as NativeChatRuntimeOwnerState
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
