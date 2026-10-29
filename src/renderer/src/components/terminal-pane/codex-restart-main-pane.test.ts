import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import type { PublishedTab } from '../../../../shared/workspace-layout/workspace-layout-published'
import { awaitsCodexRestartAnswer } from '../codex-restart-notice-state'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'
import { resetCodexDetachedPaneRestartExecutorForTests } from './codex-detached-pane-restart-scheduler'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'

function mainTab(leafIds: string[]): PublishedTab {
  return {
    id: 'tab-1',
    kind: 'terminal',
    entityId: 'tab-1',
    executionHostId: 'local',
    createdAt: 1,
    customTitle: null,
    color: null,
    terminal: {
      root: leafIds[0] ? { type: 'leaf', leafId: leafIds[0] } : null,
      panes: leafIds.map((leafId) => ({ leafId, ptyId: OLD_PTY }))
    }
  }
}

/** A queued restart of the tab's one pane, whose window layout lost its root. */
function seedQueuedRestart(mainLeafIds: string[]): void {
  provideLayoutFrameTerminalPanes({
    holdsTerminalPane: () => false,
    terminalTab: (worktreeId, tabId) =>
      worktreeId === 'wt1' && tabId === 'tab-1' ? mainTab(mainLeafIds) : undefined
  })
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart reads only this setting.
    settings: { activeRuntimeEnvironmentId: null } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart reads only the worktree's id and path.
    worktreesByRepo: { repo1: [{ id: 'wt1', path: '/Users/dev/code/orca' }] } as never,
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'codex'
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: null,
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    }
  })
  useAppStore
    .getState()
    .markCodexRestartNotices([
      { ptyId: OLD_PTY, previousAccountLabel: 'a@example.com', nextAccountLabel: 'b@example.com' }
    ])
  useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'codex')
}

describe('an account-switch restart in a layout-owner build', () => {
  beforeEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.stubGlobal('window', {
      ...globalThis.window,
      api: {
        ...globalThis.window?.api,
        pty: {
          ...globalThis.window?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    vi.unstubAllGlobals()
  })

  it('binds into the pane main holds, with no root graft and no window tree', async () => {
    seedQueuedRestart([LEAF_ID])

    await sweepUnclaimedCodexPaneRestarts()

    const args = vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]
    expect(args).toMatchObject({ tabId: 'tab-1', leafId: LEAF_ID, replacesPtyId: OLD_PTY })
    expect(args).not.toHaveProperty('placement')
    // Main's frame draws the binding; the window writes no one-pane tree of its own.
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.root).toBeNull()
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toEqual([NEW_PTY])
  })

  it("starts nothing for a pane main's layout does not hold, and asks again", async () => {
    seedQueuedRestart(['22222222-2222-4222-8222-222222222222'])

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(
      awaitsCodexRestartAnswer(useAppStore.getState().codexRestartNoticeByPtyId[OLD_PTY])
    ).toBe(true)
  })
})
