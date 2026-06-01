import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../shared/types'
import { resolveWorktreeStatus } from './worktree-status'

const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

function splitLayoutRoot(): TerminalPaneLayoutNode {
  return {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: LEAF_ID_1 },
    second: { type: 'leaf', leafId: LEAF_ID_2 }
  }
}

describe('resolveWorktreeStatus terminal layout roots', () => {
  it('suppresses stale working titles without full layout snapshots', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': ['pty-0'] },
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]',
          2: 'bash'
        }
      },
      freshHookLeafIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutRootsByTabId: {
        'tab-1': splitLayoutRoot()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })
})
