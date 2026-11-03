import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { resolveWorktreeStatus } from './worktree-status'

const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

// Tests declare live tab IDs; tab.ptyId survives sleep as a wake hint and must not imply liveness.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID_1 },
      second: { type: 'leaf', leafId: LEAF_ID_2 }
    },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

describe('resolveWorktreeStatus', () => {
  it('lets a hook-covered done pane suppress its stale working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]',
          2: 'bash'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })

  it('keeps sibling pane working when hook done covers only another pane', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'bash',
          2: 'codex [working]'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })
})
