import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { buildTitleDerivedAgentRows } from './worktree-title-derived-agent-rows'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function jcodeRow(title: string) {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const rows = buildTitleDerivedAgentRows({
    tabs: [tab],
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
    },
    // Linux reads jcode-linux-x86_64.bin; the foreground tracker publishes it as jcode.
    paneForegroundAgentByPaneKey: {
      [PANE_KEY]: { agent: 'jcode', agentEvidence: 'process-read', shellForeground: false }
    },
    seenPaneKeys: new Set(),
    now: 0
  })
  return rows.map((row) => ({ agentType: row.agentType, state: row.state }))
}

describe('title-derived Jcode rows', () => {
  it('keeps the row through Jcode titles and follows its turn tail', () => {
    expect(jcodeRow('🐩 jcode/marsh Poodle')).toEqual([{ agentType: 'jcode', state: 'idle' }])
    expect(jcodeRow('🦊 Fix codex hooks · +3 -1 · work ~12s')).toEqual([
      { agentType: 'jcode', state: 'working' }
    ])
    expect(jcodeRow('🦊 Fix codex hooks · last ~2m05s')).toEqual([
      { agentType: 'jcode', state: 'idle' }
    ])
  })
})
