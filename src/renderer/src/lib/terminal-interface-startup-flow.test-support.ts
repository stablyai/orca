import {
  terminalStartupBinding,
  terminalStartupSnapshot
} from '../../../shared/terminal-interface-startup.test-support'
import { expect, it } from 'vitest'
import type { TerminalState } from '../store/terminals/terminal-state'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { buildMobileTerminalSurfaceTabs } from '../runtime/sync-runtime-graph/mobile-session-terminal-tabs'
import type { MobileSessionWorktreeInputs } from '../runtime/sync-runtime-graph/types'

/** Pin the real startup producer's exact renderer-to-host snapshot contract. */
export async function proveTerminalStartupInterfaceFlow(
  startup: TerminalState['pendingStartupByTabId'][string],
  draft: string | undefined,
  worktreeId: string
): Promise<void> {
  expect(startup.command).toBeTruthy()
  const agent = startup.launchAgent
  if (!agent) {
    throw new Error('expected startup agent')
  }
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = terminalStartupBinding.paneKey
  const terminal: TerminalTab = {
    id: 'tab',
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: agent
  }
  const inputs: MobileSessionWorktreeInputs = {
    worktreeId,
    worktreeInstanceId: undefined,
    terminalTabs: [terminal],
    browserWorkspaces: [],
    unifiedTabs: [],
    groups: [],
    tabBarOrder: [],
    activeGroupId: null,
    tabGroupLayout: undefined,
    openFilesById: undefined,
    openFileIds: [],
    terminalLayoutByTabId: new Map([
      ['tab', { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }]
    ]),
    paneTitlesByTabId: new Map(),
    launchDraftByPaneKey: new Map(
      draft && agent ? [[paneKey, { tabId: 'tab', agent, text: draft, createdAt: 1 }]] : []
    ),
    agentStatusByPaneKey: new Map(),
    editorDraftVersionByFileId: new Map(),
    pagesByBrowserWorkspaceId: new Map(),
    certificateFailureByBrowserPageId: new Map(),
    activeEditorFileId: null,
    activeEditorTabType: null,
    activeTerminalTabId: 'tab',
    activeBrowserWorkspaceId: null,
    generatedTitlesEnabled: false,
    terminalTheme: undefined,
    mountedSurfaceCaptureByTabId: new Map()
  }
  for (const bound of [false, true]) {
    terminal.ptyId = bound ? terminalStartupBinding.ptyId : null
    expect(buildMobileTerminalSurfaceTabs(inputs, terminal)).toEqual(
      terminalStartupSnapshot(agent, draft, worktreeId, bound).tabs
    )
  }
}

export function registerTerminalStartupProducerFlow(
  produce: (prompt: string | undefined) => Promise<{
    startup: TerminalState['pendingStartupByTabId'][string]
    draft: string | undefined
    worktreeId: string
  }>
): void {
  it.each([undefined, 'Keep this editable'])(
    'publishes real new-tab startup through unbound and bound mobile snapshots (draft=%s)',
    async (prompt) => {
      const { startup, draft, worktreeId } = await produce(prompt)
      expect(draft).toBe(prompt)
      await proveTerminalStartupInterfaceFlow(startup, draft, worktreeId)
    }
  )
}
