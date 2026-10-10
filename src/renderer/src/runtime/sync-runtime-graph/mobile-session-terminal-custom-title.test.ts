import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { MobileSessionWorktreeInputs } from './types'
import { buildMobileTerminalSurfaceTabs } from './mobile-session-terminal-tabs'

// Local snapshot projection does not open a remote terminal stream.
vi.mock('../runtime-terminal-stream', () => ({ parseRemoteRuntimePtyId: () => null }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const tab: TerminalTab = {
  id: 'tab-1',
  worktreeId: 'wt-1',
  ptyId: null,
  title: 'Cowork',
  customTitle: ' Radar ',
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function inputs(layout: TerminalLayoutSnapshot): MobileSessionWorktreeInputs {
  return {
    worktreeId: 'wt-1',
    worktreeInstanceId: undefined,
    terminalTabs: [tab],
    browserWorkspaces: [],
    unifiedTabs: [],
    groups: [],
    tabBarOrder: [tab.id],
    activeGroupId: null,
    tabGroupLayout: undefined,
    openFilesById: undefined,
    openFileIds: [],
    terminalLayoutByTabId: new Map([[tab.id, layout]]),
    paneTitlesByTabId: new Map(),
    launchDraftByPaneKey: new Map(),
    agentStatusByPaneKey: new Map(),
    editorDraftVersionByFileId: new Map(),
    pagesByBrowserWorkspaceId: new Map(),
    certificateFailureByBrowserPageId: new Map(),
    activeEditorFileId: null,
    activeEditorTabType: null,
    activeTerminalTabId: tab.id,
    activeBrowserWorkspaceId: null,
    generatedTitlesEnabled: false,
    terminalTheme: undefined,
    mountedSurfaceCaptureByTabId: new Map()
  }
}

const single: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: LEAF },
  activeLeafId: LEAF,
  expandedLeafId: null
}

describe('mobile terminal rename provenance', () => {
  it('publishes the explicit rename separately from the title resolved for display', () => {
    expect(buildMobileTerminalSurfaceTabs(inputs(single), tab)[0]).toMatchObject({
      id: `${tab.id}::${LEAF}`,
      title: 'Radar',
      customTitle: 'Radar',
      leafId: LEAF
    })
  })

  it('omits the rename metadata after the user clears it', () => {
    const [result] = buildMobileTerminalSurfaceTabs(inputs(single), { ...tab, customTitle: null })
    expect(result?.title).toBe('Cowork')
    expect(result).not.toHaveProperty('customTitle')
  })

  it('keeps parent tab metadata away from independent split panes', () => {
    const split: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: OTHER_LEAF }
      },
      activeLeafId: LEAF,
      expandedLeafId: null,
      titlesByLeafId: { [LEAF]: 'First agent', [OTHER_LEAF]: 'Second agent' }
    }
    const panes = buildMobileTerminalSurfaceTabs(inputs(split), tab)
    expect(panes.map((pane) => pane.title)).toEqual(['First agent', 'Second agent'])
    for (const pane of panes) {
      expect(pane).not.toHaveProperty('customTitle')
    }
  })
})
