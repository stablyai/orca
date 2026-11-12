import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../persistence/workspace-layout-load'
import '../persistence/workspace-layout-load-report'
import { nameBasedLoadContext } from '../persistence/workspace-layout-minted-ids'
import { localDesktopSession } from '../persistence/workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout, type PublishedWorkspaceLayout } from './workspace-layout-published'
import {
  applyWorkspaceLayoutRecordChange,
  diffPublishedLayouts,
  indexPublishedLayout
} from './workspace-layout-records'
import { GIT_KEY } from '../persistence/workspace-layout-session.test-fixture'
import { ownedEditorFileId } from '../../workspace-session/workspace-session-pane-ownership'

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

function edited(edit: (layout: PublishedWorkspaceLayout) => void) {
  const before = published()
  const after = structuredClone(before)
  edit(after)
  const change = diff(before, after)!
  const applied = applyWorkspaceLayoutRecordChange(before, change)
  return { change, before, after, applied }
}

describe('a published layout as records', () => {
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
