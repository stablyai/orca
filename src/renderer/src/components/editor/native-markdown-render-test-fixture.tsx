// @vitest-environment happy-dom
import { useEffect, useMemo } from 'react'
import { cleanup } from '@testing-library/react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type {
  PluginMarkdownRenderRequest,
  PluginMarkdownSourceRequest,
  PluginMarkdownSourceResult
} from '../../../../shared/plugins/plugin-markdown-renderer'
const connectionOwner = vi.hoisted<{ value: string | null | undefined }>(() => ({ value: null }))
const targetConnectionOwners = vi.hoisted(() => new Map<string, string | null | undefined>())
const worktreeLookup = vi.hoisted<{ value: { id: string; path: string; diffComments: never[] }[] }>(
  () => ({ value: [] })
)
const statRuntimePathMock = vi.hoisted(() => vi.fn(async () => ({ isDirectory: false })))

export const storeState = {
  openFile: vi.fn(),
  activateMarkdownLink: vi.fn(),
  openMarkdownPreview: vi.fn(),
  setMarkdownViewMode: vi.fn(),
  markdownFrontmatterVisible: {},
  setPendingEditorReveal: vi.fn(),
  addDiffComment: vi.fn(),
  deleteDiffComment: vi.fn(),
  updateDiffComment: vi.fn(),
  clearDeliveredDiffComments: vi.fn(),
  keybindings: {},
  worktreesByRepo: {},
  repos: [],
  folderWorkspaces: [],
  projectGroups: [],
  openFiles: [],
  activeFileIdByWorktree: {},
  settings: { openLinksInApp: true },
  editorFontZoomLevel: 0
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})
vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: (_worktrees: unknown, id: string) =>
    worktreeLookup.value.find((worktree) => worktree.id === id) ?? null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (settings: unknown) => settings
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: statRuntimePathMock
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) => targetConnectionOwners.get(worktreeId)
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => connectionOwner.value
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', getResourceBundle: () => ({}) },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
import MarkdownPreview from './MarkdownPreview'
import {
  NativeMarkdownRenderContext,
  type NativeMarkdownRenderContextValue
} from './native-markdown-render-context'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

export const changeListeners = new Set<() => void>()
let available = true
let output: unknown
export function setOutput(value: unknown): void {
  output = value
}
export function setAvailable(value: boolean): void {
  available = value
}
export const cancel = vi.fn(async () => {})
export const unsubscribe = vi.fn()
export const resolveSource = vi.fn(
  async (request: PluginMarkdownSourceRequest): Promise<PluginMarkdownSourceResult> => ({
    status: 'resolved',
    source: {
      fileId: request.fileId,
      documentPath: request.documentPath,
      worktreeId: request.worktreeId,
      runtimeId: 'local-runtime',
      workspacePath: '/repo'
    }
  })
)
export const renderMarkdown = vi.fn(
  async (request: PluginMarkdownRenderRequest): Promise<unknown> => ({
    status: 'rendered',
    pluginKey: 'example.query',
    sessionId: request.sessionId,
    revision: 'revision-1',
    output
  })
)
export const table = {
  kind: 'table',
  columns: ['Note'],
  rows: [
    [
      {
        text: '<img src=x onerror=alert(1)>',
        reference: { path: 'notes/one.md', base: 'workspace' }
      }
    ]
  ]
}
export const source = {
  filePath: '/repo/docs/source.md',
  sourceFileId: 'file-source',
  sourceWorktreeId: 'workspace-source',
  sourceRuntimeEnvironmentId: null
}

export function Preview({
  code = 'TABLE title',
  fileId = source.sourceFileId,
  workspaceId = source.sourceWorktreeId,
  runtimeId = source.sourceRuntimeEnvironmentId
}: {
  code?: string
  fileId?: string
  workspaceId?: string
  runtimeId?: string | null
}) {
  return (
    <MarkdownPreview
      content={`\`\`\`query\n${code}\n\`\`\``}
      filePath={source.filePath}
      sourceFileId={fileId}
      sourceWorktreeId={workspaceId}
      sourceRuntimeEnvironmentId={runtimeId}
      scrollCacheKey="native-test"
    />
  )
}

export function Rich({
  code = 'TABLE title',
  language = 'query',
  context,
  onEditor
}: {
  code?: string
  language?: string
  context: NativeMarkdownRenderContextValue
  onEditor: (editor: Editor) => void
}) {
  const extensions = useMemo(
    () => createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    []
  )
  const editor = useEditor({
    extensions,
    content: `\`\`\`${language}\n${code}\n\`\`\``,
    contentType: 'markdown',
    immediatelyRender: false
  })
  useEffect(() => {
    if (editor) {
      onEditor(editor)
    }
  }, [editor, onEditor])
  return (
    <NativeMarkdownRenderContext.Provider value={context}>
      <EditorContent editor={editor} />
    </NativeMarkdownRenderContext.Provider>
  )
}

beforeEach(() => {
  storeState.worktreesByRepo = {}
  available = true
  output = table
  changeListeners.clear()
  cancel.mockClear()
  unsubscribe.mockClear()
  resolveSource.mockClear()
  resolveSource.mockImplementation(async (request) =>
    request.runtimeEnvironmentId
      ? { status: 'unavailable', reason: 'unsupported-context' }
      : {
          status: 'resolved',
          source: {
            fileId: request.fileId,
            documentPath: request.documentPath,
            worktreeId: request.worktreeId,
            runtimeId: 'local-runtime',
            workspacePath: '/repo'
          }
        }
  )
  renderMarkdown.mockClear()
  renderMarkdown.mockImplementation(async (request) => ({
    status: 'rendered',
    pluginKey: 'example.query',
    sessionId: request.sessionId,
    revision: 'revision-1',
    output
  }))
  storeState.activateMarkdownLink.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: vi.fn(async () => {}) },
      plugins: {
        listMarkdownRenderers: vi.fn(async () => [
          { language: 'query', pluginKey: 'example.query', available }
        ]),
        resolveMarkdownSource: resolveSource,
        renderMarkdown,
        cancelMarkdownRender: cancel,
        onChanged: (listener: () => void) => {
          changeListeners.add(listener)
          return () => {
            changeListeners.delete(listener)
            unsubscribe()
          }
        }
      }
    }
  })
  worktreeLookup.value = [{ id: source.sourceWorktreeId, path: '/repo', diffComments: [] }]
  connectionOwner.value = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
