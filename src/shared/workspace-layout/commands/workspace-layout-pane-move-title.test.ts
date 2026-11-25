import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from '../workspace-layout-commands'
import type { LayoutTerminalTab, WorkspaceLayoutModel } from '../workspace-layout-model'

const WT = 'repo::/wt'
const STAY = '11111111-1111-4111-8111-111111111111'
const MOVE = '22222222-2222-4222-8222-222222222222'

function modelWithSplit(paneTitle?: string): WorkspaceLayoutModel {
  const source: LayoutTerminalTab = {
    id: 'tab-source',
    entityId: 'tab-source',
    createdAt: 1,
    customTitle: null,
    color: null,
    kind: 'terminal',
    terminal: { defaultTitle: 'Terminal 1' },
    panes: {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: STAY },
        second: { type: 'leaf', leafId: MOVE }
      }
    }
  }
  return {
    hostId: 'local',
    workspaces: {
      [WT]: {
        worktreeId: WT,
        tabs: [source],
        groups: [{ id: 'group-1', tabOrder: ['tab-source'] }],
        leaves: {
          [STAY]: { ptyId: 'pty-stay' },
          [MOVE]: { ptyId: 'pty-move', ...(paneTitle ? { title: paneTitle } : {}) }
        }
      }
    },
    records: {},
    legacy: { terminalRowOwners: {} }
  }
}

function movedTab(model: WorkspaceLayoutModel) {
  const result = applyLayoutCommand(
    model,
    { type: 'movePaneToNewTab', workspace: WT, tabId: 'tab-source', leafId: MOVE },
    {
      mintId: () => 'tab-new',
      mintLeafId: () => '33333333-3333-4333-8333-333333333333',
      now: () => 2
    }
  )
  if (!result.ok) {
    throw new Error(`move refused: ${JSON.stringify(result)}`)
  }
  return result.model.workspaces[WT]?.tabs.find((tab) => tab.id === 'tab-new')
}

describe('the layout owner moving a pane to a new tab', () => {
  it('stores the new tab named after the pane, in the commit that creates it', () => {
    expect(movedTab(modelWithSplit('  build watcher '))?.customTitle).toBe('build watcher')
  })

  it('leaves the new tab unnamed when the pane has no title', () => {
    expect(movedTab(modelWithSplit())?.customTitle).toBeNull()
  })
})
