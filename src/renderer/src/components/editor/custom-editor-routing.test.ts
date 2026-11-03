import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import {
  collectActivePluginCustomEditors,
  customEditorsForFile,
  type ActivePluginCustomEditor
} from '@/store/plugin-custom-editors'
import type { FileContent } from './editor-panel-content-types'
import { getEditorPanelRenderModel } from './editor-panel-render-model'

const SCENE = '{"type":"excalidraw","elements":[]}'

function plugin(
  overrides: Partial<PluginHostListEntry> & Pick<PluginHostListEntry, 'pluginKey'>
): PluginHostListEntry {
  return {
    consentFingerprint: null,
    name: overrides.pluginKey,
    version: '1.0.0',
    publisher: 'stablyai',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: true,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    customEditors: [
      { id: 'draw', title: 'Draw', extensions: ['.excalidraw'], filenames: [], priority: 'default' }
    ],
    ...overrides
  }
}

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/diagram.excalidraw',
    filePath: '/repo/diagram.excalidraw',
    relativePath: 'diagram.excalidraw',
    worktreeId: 'wt-1',
    language: 'json',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

function model(args: {
  activeFile?: OpenFile
  editors?: readonly ActivePluginCustomEditor[]
  choice?: string
  content?: Partial<FileContent>
  isChangesMode?: boolean
}) {
  const activeFile = args.activeFile ?? file()
  const editors =
    args.editors ??
    customEditorsForFile(
      activeFile.filePath,
      collectActivePluginCustomEditors([plugin({ pluginKey: 'stablyai.excalidraw' })])
    )
  return getEditorPanelRenderModel({
    activeFile,
    fileContents: { [activeFile.id]: { content: SCENE, isBinary: false, ...args.content } },
    editorDrafts: {},
    gitStatusEntries: undefined,
    gitBranchEntries: undefined,
    markdownViewMode: {},
    markdownRichModeSizeOverridden: false,
    isChangesMode: args.isChangesMode ?? false,
    canOpenWorkspaceFileBrowser: true,
    customEditors: editors,
    customEditorChoice: args.choice
  })
}

describe('custom editor routing', () => {
  it('opens a matching file in its default editor with an Editor | Source | Changes toggle', () => {
    const result = model({})
    expect(result.activeCustomEditor?.key).toBe('stablyai.excalidraw/draw')
    expect(result.availableEditorToggleModes).toEqual([
      'plugin-editor:stablyai.excalidraw/draw',
      'edit',
      'changes'
    ])
    expect(result.effectiveToggleValue).toBe('plugin-editor:stablyai.excalidraw/draw')
    expect(result.customEditorTitles).toEqual({ 'plugin-editor:stablyai.excalidraw/draw': 'Draw' })
  })

  it('shows Source when the user picked it', () => {
    const result = model({ choice: 'source' })
    expect(result.activeCustomEditor).toBeNull()
    expect(result.effectiveToggleValue).toBe('edit')
    expect(result.hasEditorToggle).toBe(true)
  })

  it('orders default editors before option ones and lets the user pick either', () => {
    const editors = customEditorsForFile(
      '/repo/diagram.excalidraw',
      collectActivePluginCustomEditors([
        plugin({
          pluginKey: 'acme.alt',
          customEditors: [
            {
              id: 'alt',
              title: 'Alt',
              extensions: ['.excalidraw'],
              filenames: [],
              priority: 'option'
            }
          ]
        }),
        plugin({ pluginKey: 'stablyai.excalidraw' })
      ])
    )
    expect(editors.map((editor) => editor.key)).toEqual([
      'stablyai.excalidraw/draw',
      'acme.alt/alt'
    ])
    expect(model({ editors }).activeCustomEditor?.key).toBe('stablyai.excalidraw/draw')
    expect(model({ editors, choice: 'acme.alt/alt' }).activeCustomEditor?.key).toBe('acme.alt/alt')
  })

  it('never opens an Orca-core file type by default but still offers the editor', () => {
    const editors = (filePath: string) =>
      customEditorsForFile(
        filePath,
        collectActivePluginCustomEditors([
          plugin({
            pluginKey: 'acme.json',
            customEditors: [
              {
                id: 'json',
                title: 'Json',
                extensions: ['.json', '.md'],
                filenames: [],
                priority: 'default'
              }
            ]
          })
        ])
      )
    const config = file({ id: '/repo/config.json', filePath: '/repo/config.json' })
    const json = model({ activeFile: config, editors: editors(config.filePath) })
    expect(json.activeCustomEditor).toBeNull()
    expect(json.availableEditorToggleModes[0]).toBe('plugin-editor:acme.json/json')
    expect(
      model({ activeFile: config, editors: editors(config.filePath), choice: 'acme.json/json' })
        .activeCustomEditor?.key
    ).toBe('acme.json/json')
    expect(editors('/repo/package.json')[0]?.priority).toBe('option')
    expect(editors('/repo/.env.local')).toEqual([])

    const readme = file({
      id: '/repo/README.md',
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      language: 'markdown'
    })
    const markdown = model({ activeFile: readme, editors: editors(readme.filePath) })
    expect(markdown.activeCustomEditor).toBeNull()
    expect(markdown.availableEditorToggleModes).toEqual([
      'plugin-editor:acme.json/json',
      'source',
      'rich',
      'changes'
    ])
    expect(
      model({ activeFile: readme, editors: editors(readme.filePath), choice: 'acme.json/json' })
        .effectiveToggleValue
    ).toBe('plugin-editor:acme.json/json')
  })

  it('breaks a tie between two default editors by plugin key, not list order', () => {
    const draw = (pluginKey: string) =>
      plugin({
        pluginKey,
        customEditors: [
          {
            id: 'd',
            title: pluginKey,
            extensions: ['.excalidraw'],
            filenames: [],
            priority: 'default'
          }
        ]
      })
    const editors = customEditorsForFile(
      '/repo/diagram.excalidraw',
      collectActivePluginCustomEditors([draw('zeta.draw'), draw('alpha.draw')])
    )
    expect(editors[0]?.pluginKey).toBe('alpha.draw')
  })

  it('opens Source when only option editors match', () => {
    const editors = collectActivePluginCustomEditors([
      plugin({
        pluginKey: 'acme.alt',
        customEditors: [
          {
            id: 'alt',
            title: 'Alt',
            extensions: ['.excalidraw'],
            filenames: [],
            priority: 'option'
          }
        ]
      })
    ])
    const result = model({ editors })
    expect(result.activeCustomEditor).toBeNull()
    expect(result.availableEditorToggleModes[0]).toBe('plugin-editor:acme.alt/alt')
  })

  it('falls back to Source when the plugin is disabled or removed', () => {
    const disabled = collectActivePluginCustomEditors([
      plugin({ pluginKey: 'stablyai.excalidraw', status: 'disabled' })
    ])
    expect(disabled).toEqual([])
    const result = model({ editors: disabled, choice: 'stablyai.excalidraw/draw' })
    expect(result.activeCustomEditor).toBeNull()
    expect(result.availableEditorToggleModes).toEqual(['edit', 'changes'])
  })

  it('keeps raw source for read-only tabs, binary files, load errors and conflicts', () => {
    expect(model({ activeFile: file({ readOnly: true }) }).activeCustomEditor).toBeNull()
    expect(model({ content: { isBinary: true } }).activeCustomEditor).toBeNull()
    expect(model({ content: { loadError: 'gone' } }).activeCustomEditor).toBeNull()
    expect(
      model({
        activeFile: file({
          conflict: {
            kind: 'conflict-editable',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved',
            conflictStatusSource: 'git'
          }
        })
      }).activeCustomEditor
    ).toBeNull()
  })

  it('shows Changes instead of the editor while Changes is chosen', () => {
    const result = model({ isChangesMode: true })
    expect(result.activeCustomEditor).toBeNull()
    expect(result.effectiveToggleValue).toBe('changes')
  })

  it('routes remote files exactly like local ones', () => {
    const remote = file({
      id: 'ssh:/home/me/diagram.excalidraw',
      filePath: '/home/me/diagram.excalidraw',
      runtimeEnvironmentId: 'env-ssh'
    })
    expect(model({ activeFile: remote }).activeCustomEditor?.key).toBe('stablyai.excalidraw/draw')
  })

  describe('bytes editors', () => {
    const sheet = file({
      id: '/repo/book.xlsx',
      filePath: '/repo/book.xlsx',
      relativePath: 'book.xlsx',
      language: 'plaintext'
    })
    const sheetEditors = customEditorsForFile(
      sheet.filePath,
      collectActivePluginCustomEditors([
        plugin({
          pluginKey: 'stablyai.spreadsheet',
          customEditors: [
            {
              id: 'sheet',
              title: 'Spreadsheet',
              extensions: ['.xlsx'],
              filenames: [],
              priority: 'default',
              contentKind: 'bytes'
            }
          ]
        })
      ])
    )
    const byteSource = { target: { kind: 'local' as const }, filePath: '/repo/book.xlsx' }

    it('opens a binary file in its bytes editor, with Source but no Changes', () => {
      const result = model({
        activeFile: sheet,
        editors: sheetEditors,
        content: { content: '', isBinary: true, byteSource }
      })
      expect(result.activeCustomEditor?.key).toBe('stablyai.spreadsheet/sheet')
      expect(result.availableEditorToggleModes).toEqual([
        'plugin-editor:stablyai.spreadsheet/sheet',
        'edit'
      ])
    })

    it('opens read-only tabs too; the tab refuses its edits', () => {
      expect(
        model({
          activeFile: { ...sheet, readOnly: true },
          editors: sheetEditors,
          content: { content: '', isBinary: true, byteSource }
        }).activeCustomEditor?.key
      ).toBe('stablyai.spreadsheet/sheet')
    })

    it('needs a pageable route to the bytes, and no load error', () => {
      expect(
        model({ activeFile: sheet, editors: sheetEditors, content: { isBinary: true } })
          .activeCustomEditor
      ).toBeNull()
      expect(
        model({
          activeFile: sheet,
          editors: sheetEditors,
          content: { isBinary: true, byteSource, loadError: 'gone' }
        }).activeCustomEditor
      ).toBeNull()
    })

    it('routes a remote workbook through the same route the editor loaded it on', () => {
      const remoteSource = {
        target: { kind: 'environment' as const, environmentId: 'env-ssh' },
        filePath: '/home/me/book.xlsx',
        relativePath: 'book.xlsx',
        worktreeId: 'wt-remote'
      }
      expect(
        model({
          activeFile: { ...sheet, runtimeEnvironmentId: 'env-ssh' },
          editors: sheetEditors,
          content: { isBinary: true, byteSource: remoteSource }
        }).activeCustomEditor?.key
      ).toBe('stablyai.spreadsheet/sheet')
    })
  })
})
