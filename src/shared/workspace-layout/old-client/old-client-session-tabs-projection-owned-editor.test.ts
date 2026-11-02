// An editor tab under its owned id (a floating file, a tab moved to its file's workspace) still
// gets a row in the phone and old-client tab lists.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ownedEditorFileId } from '../../workspace-session-pane-ownership'
import { projectSessionTabs, type SessionTabsFacts } from './old-client-session-tabs-projection'
import { build, testContext, WS } from '../workspace-layout-command.test-fixture'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const FILE = '/Users/dev/orca/README.md'
const noFacts: SessionTabsFacts = { tabLabels: {}, terminalRows: {}, browserTabs: {} }

function projectOwnedReadme() {
  const fileId = ownedEditorFileId(FILE, WS, 'env-1')
  const { model, results } = build(testContext(), [
    {
      type: 'openEditorTab',
      workspace: WS,
      fileId,
      contentType: 'editor',
      file: {
        filePath: FILE,
        relativePath: 'README.md',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1'
      }
    }
  ])
  const view = {
    groups: {},
    panes: {},
    editorDrafts: { [WS]: { [FILE]: { dirtyDraftContent: '# draft' } } }
  }
  return {
    tabId: results[0]!.tabId!,
    projected: projectSessionTabs(WS, model.workspaces[WS]!, view, noFacts, false)
  }
}

describe('projectSessionTabs with an owned editor id', () => {
  it('lists the file with the layout-owner switch on', () => {
    const { tabId, projected } = projectOwnedReadme()
    expect(projected.tabs).toEqual([
      expect.objectContaining({
        id: tabId,
        type: 'markdown',
        filePath: FILE,
        relativePath: 'README.md',
        title: 'README.md',
        isDirty: true
      })
    ])
  })

  it('keeps matching by path alone with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    expect(projectOwnedReadme().projected.tabs).toEqual([])
  })
})
