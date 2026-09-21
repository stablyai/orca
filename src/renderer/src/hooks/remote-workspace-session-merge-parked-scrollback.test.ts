import { describe, expect, it } from 'vitest'

import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab, TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'

/**
 * A reconnect must not delete the only copy of a parked remote pane's scrollback.
 *
 * A remote-runtime pty's bytes never transit main, so the park capture in
 * `terminalLayoutsByTabId[tabId].buffersByLeafId` is the client's only copy. The reconnect replaces
 * a replaced tab's layout wholesale, and a park capture does not bump `tab.generation` — so the tab
 * is not in `locallyPreservedTabIds` and, before this was fixed, its scrollback went with the
 * layout. The host never mints scrollback of its own; its copy is only ever an earlier upload.
 */
const WORKTREE = 'repo-1::/home/user/remote-checkout'
const TAB = 'tab-parked'
const LEAF = 'leaf-1'

// Why a complete tab rather than a cast partial: the merge reads `generation` to decide local
// preservation, so a fixture missing it would make the control pass for the wrong reason.
function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB,
    ptyId: null,
    worktreeId: WORKTREE,
    title: TAB,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    generation: 1,
    ...overrides
  }
}

function layout(overrides: Partial<TerminalLayoutSnapshot> = {}): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ...overrides
  }
}

function sessionState(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeTabId: TAB,
    ...overrides
  }
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  liveTabs: AppState['tabsByWorktree'] = {}
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    new Set([WORKTREE]),
    liveTabs,
    new Set()
  )
}

describe('direct-SSH reconnect merge: parked scrollback', () => {
  it('keeps the park capture when the host copy predates it and no generation changed', () => {
    const tab = terminalTab()
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [tab] },
      terminalLayoutsByTabId: {
        [TAB]: layout({ buffersByLeafId: { [LEAF]: 'parked-scrollback' } })
      }
    })
    // Same generation on both sides is the whole point: nothing marks this tab as locally newer.
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [tab] },
      terminalLayoutsByTabId: { [TAB]: layout() }
    })

    const merged = merge(current, remote, { [WORKTREE]: [tab] })

    expect(merged.terminalLayoutsByTabId[TAB]?.buffersByLeafId).toEqual({
      [LEAF]: 'parked-scrollback'
    })
  })

  it('still lets the host own the layout structure it changed while we were away', () => {
    const tab = terminalTab()
    const splitRoot: TerminalLayoutSnapshot['root'] = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF },
      second: { type: 'leaf', leafId: 'leaf-2' }
    }
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [tab] },
      terminalLayoutsByTabId: {
        [TAB]: layout({ buffersByLeafId: { [LEAF]: 'parked-scrollback' } })
      }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [tab] },
      terminalLayoutsByTabId: { [TAB]: layout({ root: splitRoot }) }
    })

    const merged = merge(current, remote, { [WORKTREE]: [tab] })

    expect(merged.terminalLayoutsByTabId[TAB]?.root).toEqual(splitRoot)
    expect(merged.terminalLayoutsByTabId[TAB]?.buffersByLeafId).toEqual({
      [LEAF]: 'parked-scrollback'
    })
  })
})
