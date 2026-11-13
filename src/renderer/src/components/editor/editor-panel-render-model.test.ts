import { describe, expect, it } from 'vitest'
import type { ActivePluginCustomEditor } from '@/store/plugins/file-editors/plugin-custom-editors'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from './editor-panel-content-types'
import { getEditorPanelRenderModel } from './editor-panel-render-model'

function editor(fields: Partial<ActivePluginCustomEditor> = {}): ActivePluginCustomEditor {
  return {
    id: 'bpmn',
    title: 'BPMN',
    extensions: ['.bpmn'],
    filenames: [],
    priority: 'default',
    key: 'miragon.bpmn/bpmn',
    pluginKey: 'miragon.bpmn',
    pluginName: 'BPMN',
    ...fields
  }
}

const diffTab: OpenFile = {
  id: 'diff:unstaged:process.bpmn',
  filePath: '/repo/process.bpmn',
  relativePath: 'process.bpmn',
  worktreeId: 'wt',
  language: 'xml',
  isDirty: false,
  mode: 'diff',
  diffSource: 'unstaged'
}

const textDiff: DiffContent = {
  kind: 'text',
  originalContent: '<before/>',
  modifiedContent: '<after/>',
  originalIsBinary: false,
  modifiedIsBinary: false
}

function model({
  file = diffTab,
  diffContent = textDiff,
  editors = [editor({ diff: true })],
  choice
}: {
  file?: OpenFile
  diffContent?: DiffContent
  editors?: ActivePluginCustomEditor[]
  choice?: string
} = {}) {
  return getEditorPanelRenderModel({
    activeFile: file,
    fileContents: {},
    editorDrafts: {},
    gitStatusEntries: undefined,
    gitBranchEntries: undefined,
    markdownViewMode: {},
    markdownRichModeSizeOverridden: false,
    isChangesMode: false,
    canOpenWorkspaceFileBrowser: false,
    customEditors: editors,
    customEditorChoice: choice,
    diffContent
  })
}

describe('custom editors in a diff tab', () => {
  it('offers a diff editor beside Orca diff, which stays the default until picked', () => {
    const offered = model()
    expect(offered.availableEditorToggleModes).toEqual(['plugin-editor:miragon.bpmn/bpmn', 'edit'])
    expect(offered.activeCustomEditor).toBeNull()
    expect(offered.isDiffSurface).toBe(true)

    const picked = model({ choice: 'miragon.bpmn/bpmn' })
    expect(picked.activeCustomEditor?.key).toBe('miragon.bpmn/bpmn')
    expect(picked.isDiffSurface).toBe(false)
  })

  it('offers only editors that opted into diffs, and only for a diff that loaded', () => {
    expect(model().customEditors).toHaveLength(1)
    expect(model({ editors: [editor()] }).customEditors).toEqual([])
    expect(model({ diffContent: { ...textDiff, loadFailed: true } }).customEditors).toEqual([])
  })

  it('offers no editor when a rename brings in a file it does not open', () => {
    const renamed = (branchOldPath: string) =>
      model({
        file: { ...diffTab, diffSource: 'staged', branchOldPath },
        diffContent: { ...textDiff, readWithOldPath: branchOldPath }
      }).customEditors
    expect(renamed('notes.txt')).toEqual([])
    expect(renamed('old-process.bpmn')).toHaveLength(1)
  })

  it('offers no editor while the diff on screen was read for a rename that went away', () => {
    const staleRename = { ...textDiff, readWithOldPath: 'notes.txt' }
    expect(
      model({ file: { ...diffTab, diffSource: 'staged' }, diffContent: staleRename }).customEditors
    ).toEqual([])
  })
})
