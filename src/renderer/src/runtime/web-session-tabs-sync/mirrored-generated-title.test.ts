import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildMirroredTerminalTabs } from './terminal-build'
import { toWebTerminalSurfaceTabId } from '../web-terminal-surface-id'

const HOST_TAB = 'host-tab-1'
const SNAPSHOT: RuntimeMobileSessionTabsResult = {
  worktree: 'repo-1::worktree-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1,
  activeGroupId: 'group-1',
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'terminal',
      id: 'surface-1',
      parentTabId: HOST_TAB,
      leafId: 'leaf-1',
      title: 'Terminal',
      status: 'ready',
      terminal: 'handle-1',
      isActive: true
    }
  ]
}

function makeExisting(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'repo-1::worktree-1',
    title: 'Terminal',
    generatedTitle: 'Fix intake flow',
    generatedTitlePaneKey: `${id}:leaf-1`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('buildMirroredTerminalTabs generated title', () => {
  function rebuild(existing: TerminalTab, lookupId: string): TerminalTab | undefined {
    const [mirrored] = buildMirroredTerminalTabs(
      SNAPSHOT,
      'env-1',
      new Map([[lookupId, existing]]),
      {},
      0,
      1_000
    )
    return mirrored?.tab
  }

  it('keeps the client-local generated title and its source pane across a host rebuild', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    expect(rebuild(makeExisting(localTabId), localTabId)).toMatchObject({
      generatedTitle: 'Fix intake flow',
      generatedTitlePaneKey: `${localTabId}:leaf-1`
    })
  })

  it('drops a source pane recorded under another tab id so the title is not hidden', () => {
    const tab = rebuild(makeExisting(HOST_TAB), HOST_TAB)
    expect(tab?.generatedTitle).toBe('Fix intake flow')
    expect(tab && 'generatedTitlePaneKey' in tab).toBe(false)
  })
})
