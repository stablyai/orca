import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EditorContent } from '@/components/editor/EditorContent'
import EditorViewToggle from '@/components/editor/EditorViewToggle'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import type { EditorPopoutOpenRequest } from '../../../../shared/editor-popout'
import { readEditorPopoutDocument, saveEditorPopoutDocument } from './editor-popout-save'
import {
  canCloseEditorPopoutAfterSave,
  isEditorPopoutContentDirty,
  runEditorPopoutSave
} from './editor-popout-save-coordinator'

const MARKDOWN_VIEW_MODES = ['source', 'rich', 'preview'] as const

function LoadedEditorPopout({ request }: { request: EditorPopoutOpenRequest }): React.JSX.Element {
  const [content, setContent] = useState(request.content)
  const [savedContent, setSavedContent] = useState(request.savedContent)
  const [viewMode, setViewMode] = useState<MarkdownViewMode>(request.viewMode)
  const showFrontmatter = request.showFrontmatter
  const [saving, setSaving] = useState(false)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const contentRef = useRef(content)
  const dirtyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = isEditorPopoutContentDirty(content, savedContent)
  contentRef.current = content
  dirtyRef.current = dirty
  const file = useMemo<OpenFile>(
    () => ({ ...request.document, isDirty: dirty, mode: 'edit' }),
    [dirty, request]
  )
  const fileName = getRuntimePathBasename(file.filePath)

  useEffect(() => {
    useAppStore.setState((state) => ({
      openFiles: [file],
      activeFileId: file.id,
      activeFileIdByWorktree: { ...state.activeFileIdByWorktree, [file.worktreeId]: file.id },
      editorViewMode: { ...state.editorViewMode, [file.id]: 'edit' },
      markdownViewMode: { ...state.markdownViewMode, [file.id]: viewMode },
      markdownFrontmatterVisible: {
        ...state.markdownFrontmatterVisible,
        [file.id]: showFrontmatter
      }
    }))
  }, [file, showFrontmatter, viewMode])

  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${fileName} - Orca`
    void window.api.editorPopout.setDirty(dirty)
  }, [dirty, fileName])

  const save = useCallback(
    (nextContent: string = content): Promise<boolean> => {
      return runEditorPopoutSave(savePromiseRef, async () => {
        setContent(nextContent)
        setSaving(true)
        setError(null)
        try {
          const result = await saveEditorPopoutDocument(request, nextContent, savedContent)
          if (!result.ok) {
            setError(
              result.reason === 'external-change'
                ? translate(
                    'editorPopout.externalChange',
                    'This file changed outside the detached editor. Reopen it before saving.'
                  )
                : translate(
                    'editorPopout.binarySaveUnsupported',
                    'Binary files cannot be saved here.'
                  )
            )
            return false
          }
          setSavedContent(nextContent)
          return true
        } catch (cause) {
          console.error('[editor-popout] save failed', cause)
          setError(
            translate(
              'editorPopout.saveFailed',
              'Could not save this file. If its remote connection changed, reopen the window and try again.'
            )
          )
          return false
        } finally {
          setSaving(false)
        }
      })
    },
    [content, request, savedContent]
  )

  const reload = useCallback(async (): Promise<void> => {
    if (dirty) {
      setError(
        translate(
          'editorPopout.reloadDirty',
          'Save or discard your changes before reloading this file.'
        )
      )
      return
    }
    try {
      const next = await readEditorPopoutDocument(request)
      if (next.isBinary) {
        setError(
          translate('editorPopout.binaryEditUnsupported', 'Binary files cannot be edited here.')
        )
        return
      }
      setContent(next.content)
      setSavedContent(next.content)
      setError(null)
    } catch (cause) {
      console.error('[editor-popout] reload failed', cause)
      setError(
        translate(
          'editorPopout.reloadFailed',
          'Could not reload this file. If its remote connection changed, reopen the window and try again.'
        )
      )
    }
  }, [dirty, request])

  useEffect(() => {
    const offRequestCloseState = window.api.editorPopout.onRequestCloseState(() => {
      void window.api.editorPopout.reportCloseState(dirtyRef.current)
    })
    return offRequestCloseState
  }, [])

  useEffect(() => {
    const offSaveAndClose = window.api.editorPopout.onSaveAndClose(() => {
      const contentSnapshot = contentRef.current
      void save(contentSnapshot).then((saved) =>
        window.api.editorPopout.completeSaveAndClose(
          canCloseEditorPopoutAfterSave(saved, contentSnapshot, contentRef.current)
        )
      )
    })
    return offSaveAndClose
  }, [save])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const commandPressed = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (commandPressed && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [save])

  return (
    <div className="flex h-screen min-h-0 flex-col bg-editor-surface text-foreground">
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-border bg-background px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {dirty ? '● ' : ''}
            {fileName}
          </div>
          <div className="truncate text-xs text-muted-foreground">{file.filePath}</div>
        </div>
        <EditorViewToggle
          value={viewMode}
          modes={MARKDOWN_VIEW_MODES}
          onChange={(next) => setViewMode(next as MarkdownViewMode)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {translate('editorPopout.save', 'Save')}
        </Button>
      </header>
      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <EditorContent
          activeFile={file}
          viewStateScopeId={`editor-popout:${file.id}`}
          fileContents={{
            [file.id]: { content: savedContent, isBinary: false }
          }}
          diffContents={{}}
          editBuffers={{ [file.id]: content }}
          openFiles={[file]}
          worktreeEntries={[]}
          resolvedLanguage="markdown"
          isMarkdown
          isMermaid={false}
          isCsv={false}
          isNotebook={false}
          mdViewMode={viewMode}
          isChangesMode={false}
          sideBySide={false}
          showMarkdownFrontmatter={showFrontmatter}
          markdownAnnotationsEnabled={false}
          pendingEditorReveal={null}
          handleContentChange={setContent}
          handleContentChangeForFile={(_openFile, nextContent) => setContent(nextContent)}
          handleDirtyStateHint={() => undefined}
          handleSave={save}
          handleSaveForFile={(_openFile, nextContent) => save(nextContent)}
          reloadContent={() => void reload()}
        />
      </div>
    </div>
  )
}

export function EditorPopoutRoot(): React.JSX.Element {
  const [request, setRequest] = useState<EditorPopoutOpenRequest | null | undefined>()

  useEffect(() => {
    let disposed = false
    void window.api.editorPopout.getState().then((next) => {
      if (!disposed) {
        setRequest(next)
      }
    })
    return () => {
      disposed = true
    }
  }, [])

  if (request === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-editor-surface text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }
  if (!request) {
    return (
      <div className="flex h-screen items-center justify-center bg-editor-surface p-6 text-sm text-destructive">
        {translate('editorPopout.stateUnavailable', 'The detached editor state is unavailable.')}
      </div>
    )
  }
  return <LoadedEditorPopout request={request} />
}
