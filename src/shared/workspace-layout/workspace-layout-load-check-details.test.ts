import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import type { ExecutionHostId } from '../execution-host'
import type { Tab } from '../tab-types'
import type { LayoutEditorView } from './layout-editor-view'
import { loadWorkspace } from './workspace-layout-load-workspace'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { createRecordedLeafReader } from './workspace-layout-recorded-key-order'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const key = 'wt-checks'

function checkTab(id: string, executionHostId: ExecutionHostId): Tab {
  return {
    id,
    entityId: `${key}::check-details::${id}`,
    worktreeId: key,
    groupId: 'g1',
    contentType: 'check-details',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    executionHostId
  }
}

function load(entries: Tab[], hostId: ExecutionHostId) {
  const views: Record<string, LayoutEditorView> = Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      {
        view: { mode: 'check-details' },
        file: { filePath: entry.entityId, relativePath: entry.label, language: 'plaintext' }
      }
    ])
  )
  const session = { ...getDefaultWorkspaceSession(), unifiedTabs: { [key]: entries } }
  return () =>
    loadWorkspace(
      {
        session,
        hostId,
        key,
        terminalHomes: new Map(),
        context: { ...nameBasedLoadContext(), editorViewsOf: () => views },
        view: {
          activeRepoId: null,
          activeWorktreeId: key,
          activeTabId: null,
          groups: {},
          lastFocusedAt: {},
          panes: {},
          editorDrafts: {}
        },
        facts: { tabLabels: {}, terminalRows: {}, scrollback: {}, browserTabs: {} },
        layouts: new Map(),
        canonicalTabIdBySubsumedTabId: new Map()
      },
      createRecordedLeafReader(session)
    )
}

it.each(['local', 'ssh:builder'] as const)(
  'bounds stored tab ID reads on repeated %s check-tab reconstruction',
  (hostId) => {
    const count = 128
    let idReads = 0
    const entries = Array.from({ length: count }, (_, index) => {
      const id = `check-${index}`
      return {
        ...checkTab(id, hostId),
        get id() {
          idReads++
          return id
        }
      }
    })
    const reconstruct = load(entries, hostId)
    for (let attempt = 0; attempt < 2; attempt++) {
      idReads = 0
      const workspace = reconstruct()
      expect(workspace.tabs).toHaveLength(count)
      expect(idReads).toBeLessThan(count * 20)
      const scope = hostId === 'local' ? '' : `@${hostId}`
      expect(workspace.tabs[count - 1]?.entityId).toBe(
        `${key}::check-details${scope}::check-${count - 1}`
      )
      expect(workspace.editorViews?.['check-127']?.file.filePath).toBe(
        workspace.tabs[count - 1]?.entityId
      )
    }
  }
)

it('keeps the first stored owner when check-tab IDs repeat', () => {
  const workspace = load(
    [checkTab('duplicate', 'ssh:builder'), checkTab('duplicate', 'runtime:other')],
    'local'
  )()
  expect(workspace.tabs).toMatchObject([
    { id: 'duplicate', entityId: `${key}::check-details@ssh:builder::duplicate` }
  ])
  expect(workspace.editorViews?.duplicate?.file.filePath).toBe(workspace.tabs[0]?.entityId)
})
