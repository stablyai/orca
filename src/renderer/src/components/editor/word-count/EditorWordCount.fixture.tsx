import { loader } from '@monaco-editor/react'
import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OpenFile, MarkdownViewMode } from '@/store/slices/editor/types/open-file'
import { Button } from '@/components/ui/button'
import { EditorPanelShell } from '../panel/EditorPanelShell'
import { getEditorPanelRenderModel } from '../panel/editor-panel-render-model'

const noop = () => {}
const save = async () => true
const first: OpenFile = {
  id: 'word-count-first',
  filePath: '/word-count/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'word-count',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}
const second: OpenFile = {
  ...first,
  id: 'word-count-second',
  filePath: '/word-count/next.md',
  relativePath: 'next.md'
}

function WordCountFixture() {
  const [file, setFile] = useState(first)
  const [mode, setMode] = useState<MarkdownViewMode>('source')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const fileContents = {
    [first.id]: { content: 'Hello world\n안녕 세상\nA final paragraph', isBinary: false },
    [second.id]: { content: '새 문서', isBinary: false }
  }
  const model = getEditorPanelRenderModel({
    activeFile: file,
    fileContents,
    editorDrafts: drafts,
    gitStatusEntries: [],
    gitBranchEntries: [],
    markdownViewMode: { [file.id]: mode },
    markdownRichModeSizeOverridden: false,
    isChangesMode: false,
    canOpenWorkspaceFileBrowser: false
  })
  return (
    <div className="flex flex-col" style={{ height: 400 }}>
      <div className="flex gap-2 p-2">
        <Button variant="outline" onClick={() => setFile(file.id === first.id ? second : first)}>
          Switch file
        </Button>
      </div>
      <EditorPanelShell
        panelRef={null}
        activeFile={file}
        activeViewStateId={file.id}
        model={model}
        copiedPathVisible={false}
        showMarkdownTableOfContents={false}
        canShowMarkdownFrontmatterToggle={false}
        markdownFrontmatterVisible={false}
        sideBySide={false}
        openFiles={[first, second]}
        fileContents={fileContents}
        diffContents={{}}
        editorDrafts={drafts}
        pendingEditorReveal={null}
        renameDialogFile={null}
        renameError={null}
        disableRenameBrowse={true}
        onCopyPath={noop}
        onOpenDiffTargetFile={noop}
        onOpenPreview={noop}
        onOpenMarkdownPreview={noop}
        onToggleSideBySide={noop}
        onEditorToggleChange={(next) => {
          if (next === 'rich' || next === 'source' || next === 'preview') {
            setMode(next)
          }
        }}
        onToggleMarkdownTableOfContents={noop}
        onToggleMarkdownFrontmatter={noop}
        onExportMarkdownToPdf={noop}
        onContentChange={(content) => setDrafts((current) => ({ ...current, [file.id]: content }))}
        onContentChangeForFile={noop}
        onDirtyStateHint={noop}
        onSave={save}
        onSaveForFile={save}
        onReloadContent={noop}
        onCloseMarkdownTableOfContents={noop}
        onCloseRenameDialog={noop}
        onRenameConfirm={async () => {}}
        markdownAnnotationsEnabled={false}
      />
    </div>
  )
}

async function waitForCount(frame: HTMLElement, count: number): Promise<void> {
  const deadline = performance.now() + 15000
  const shown = (): string | undefined =>
    frame.querySelector('.editor-header')?.textContent?.match(/(\d+) words?/)?.[1]
  while (shown() !== String(count)) {
    if (performance.now() > deadline) {
      throw new Error(`Expected ${count} words: ${frame.textContent}`)
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function selectWords(frame: HTMLElement): Promise<void> {
  await waitForCount(frame, 7)
  const monaco = await loader.init()
  const editor = monaco.editor.getEditors()[0]
  editor.setSelection(new monaco.Selection(1, 1, 1, 6))
  await waitForCount(frame, 1)
}

export const editors = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: (frame) => waitForCount(frame, 7)
})
export const selected = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: selectWords
})
export const cleared = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: async (frame) => {
    await selectWords(frame)
    const monaco = await loader.init()
    const editor = monaco.editor.getEditors()[0]
    editor.setPosition({ lineNumber: 1, column: 1 })
    await waitForCount(frame, 7)
  }
})
export const multiple = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: async (frame) => {
    await waitForCount(frame, 7)
    const monaco = await loader.init()
    monaco.editor
      .getEditors()[0]
      .setSelections([new monaco.Selection(1, 1, 1, 6), new monaco.Selection(2, 1, 2, 6)])
    await waitForCount(frame, 3)
  }
})
export const edited = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: async (frame) => {
    await waitForCount(frame, 7)
    const monaco = await loader.init()
    monaco.editor
      .getEditors()[0]
      .executeEdits('fixture', [{ range: new monaco.Range(1, 1, 1, 1), text: 'Another ' }])
    await waitForCount(frame, 8)
  }
})
export const switched = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: async (frame) => {
    await selectWords(frame)
    frame.querySelector<HTMLButtonElement>('button')?.click()
    await waitForCount(frame, 2)
  }
})
export const rich = defineFixture({
  width: 800,
  render: () => <WordCountFixture />,
  interact: async (frame) => {
    await waitForCount(frame, 7)
    frame.querySelector<HTMLButtonElement>('[aria-label="Rich Editor"]')?.click()
    const deadline = performance.now() + 15000
    while (!frame.querySelector('.rich-markdown-editor')) {
      if (performance.now() > deadline) {
        throw new Error('Rich editor did not mount')
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    await waitForCount(frame, 7)
  }
})
