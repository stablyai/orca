import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { loadWorkspaceLayoutWithoutReport } from './workspace-layout-load'
import { stableJson } from './workspace-layout-load-report'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout, type PublishedWorkspaceLayout } from './workspace-layout-published'
import {
  applyWorkspaceLayoutRecordChange,
  diffPublishedLayouts,
  indexPublishedLayout,
  joinPublishedLayout,
  splitPublishedLayout
} from './workspace-layout-records'
import { GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'

function published(): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    localDesktopSession(),
    nameBasedLoadContext()
  )
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, LOCAL_EXECUTION_HOST_ID)
}

const diff = (before: PublishedWorkspaceLayout, after: PublishedWorkspaceLayout) =>
  diffPublishedLayouts(GIT_KEY, indexPublishedLayout(before), indexPublishedLayout(after), after)

/** `before` with one edit: the frame for it carries what changed and applies back to `after`. */
function edited(edit: (layout: PublishedWorkspaceLayout) => void) {
  const before = published()
  const after = structuredClone(before)
  edit(after)
  const change = diff(before, after)!
  const applied = applyWorkspaceLayoutRecordChange(before, change)
  return { change, before, after, applied }
}

const shellPane = (layout: PublishedWorkspaceLayout, leafId: string) =>
  layout.tabs
    .find((tab) => tab.id === 'tab-shell')!
    .terminal!.panes.find((pane) => pane.leafId === leafId)!

describe('a published layout as records', () => {
  it('splits and joins back to the same layout, field for field', () => {
    const layout = published()
    expect(stableJson(joinPublishedLayout(splitPublishedLayout(layout)))).toBe(stableJson(layout))
  })

  it('keeps a pane’s binding out of its tab’s tree', () => {
    const records = splitPublishedLayout(published())
    const tree = records.paneTrees.find((candidate) => candidate.tabId === 'tab-shell')!
    expect(tree.panes.every((pane) => !('ptyId' in pane))).toBe(true)
    expect(records.bindings).toContainEqual({ leafId: leaf(1), ptyId: `${GIT_KEY}@@aaaa0001` })
  })

  it('sends nothing when nothing changed', () => {
    expect(diff(published(), published())).toBeNull()
  })

  it.each([
    [
      'a respawn under the same id: one binding record',
      (layout: PublishedWorkspaceLayout) => {
        shellPane(layout, leaf(1)).ptyGeneration = 2
      },
      {
        bindings: { set: [{ leafId: leaf(1), ptyId: `${GIT_KEY}@@aaaa0001`, ptyGeneration: 2 }] }
      }
    ],
    [
      'a pane unbound: its binding record removed',
      (layout: PublishedWorkspaceLayout) => {
        delete shellPane(layout, leaf(1)).ptyId
      },
      { bindings: { removed: [leaf(1)] } }
    ],
    [
      'a generated title: one tab row',
      (layout: PublishedWorkspaceLayout) => {
        layout.tabs[0]!.generatedTitle = 'Fix the build'
      },
      {
        tabs: {
          set: [expect.objectContaining({ id: 'tab-shell', generatedTitle: 'Fix the build' })]
        }
      }
    ],
    [
      'a tab moved within its group: the workspace fields and the tab order',
      (layout: PublishedWorkspaceLayout) => {
        layout.groups[0]!.tabIds = layout.groups[0]!.tabIds.toReversed()
        layout.tabs = [...layout.tabs.slice(0, 3).toReversed(), ...layout.tabs.slice(3)]
      },
      {
        workspace: expect.objectContaining({ groups: expect.any(Array) }),
        tabs: { order: expect.any(Array) }
      }
    ]
  ])('%s', (_case, edit, expected) => {
    const { change, after, applied } = edited(edit)
    expect(change).toEqual({ key: GIT_KEY, change: 'records', ...expected })
    expect(stableJson(applied)).toBe(stableJson(after))
  })

  it('applies a tab closed, with its tree and bindings, back to the layout without it', () => {
    const { change, after, applied } = edited((layout) => {
      layout.tabs = layout.tabs.filter((tab) => tab.id !== 'tab-shell')
      layout.groups[0]!.tabIds = layout.groups[0]!.tabIds.filter((id) => id !== 'tab-shell')
    })
    expect(change).toMatchObject({
      tabs: { removed: ['tab-shell'] },
      paneTrees: { removed: ['tab-shell'] },
      bindings: { removed: expect.arrayContaining([leaf(1)]) }
    })
    expect(stableJson(applied)).toBe(stableJson(after))
  })

  it('sends a layout whose records repeat a key whole', () => {
    const before = published()
    const after = structuredClone(before)
    after.browserTabs = [...after.browserTabs, { ...after.browserTabs[0]!, label: 'other' }]
    expect(indexPublishedLayout(after)).toBeNull()
    expect(diff(before, after)).toEqual({ key: GIT_KEY, change: 'layout', layout: after })
  })

  it("applies a layout-owner host's editor file order in a reader built without the switch", () => {
    const before = published()
    before.editorFiles = [{ filePath: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' }]
    const opened = {
      filePath: '/repo/b.ts',
      relativePath: 'b.ts',
      language: 'typescript',
      runtimeEnvironmentId: 'env-1'
    }
    // Keys as the host derives them from each record; the reader's build must not change them.
    const order = [
      ownedEditorFileId('/repo/a.ts', '', undefined),
      ownedEditorFileId('/repo/b.ts', '', 'env-1')
    ]
    const applied = applyWorkspaceLayoutRecordChange(before, {
      key: GIT_KEY,
      change: 'records',
      editorFiles: { set: [opened], order }
    })
    expect(applied?.editorFiles).toEqual([...before.editorFiles, opened])
  })

  it("keys two hosts' files at one path apart, so opening one sends only its record", () => {
    const before = published()
    const local = { filePath: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' }
    before.editorFiles = [local]
    const after = structuredClone(before)
    after.editorFiles = [local, { ...local, runtimeEnvironmentId: 'env-1' }]
    const change = diff(before, after)
    expect(change).toMatchObject({
      change: 'records',
      editorFiles: { set: [after.editorFiles[1]] }
    })
    expect(applyWorkspaceLayoutRecordChange(before, change!)).toEqual(after)
  })

  it('refuses a change that does not fit what the reader holds', () => {
    const { change } = edited((layout) => {
      layout.tabs[0]!.customTitle = 'renamed'
    })
    expect(() => applyWorkspaceLayoutRecordChange(undefined, change)).toThrow('unknown workspace')
    expect(() =>
      applyWorkspaceLayoutRecordChange(published(), {
        key: GIT_KEY,
        change: 'records',
        tabs: { order: ['tab-shell', 'missing'] }
      })
    ).toThrow(/missing/)
  })
})
