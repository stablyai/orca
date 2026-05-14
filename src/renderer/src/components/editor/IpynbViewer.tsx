/* eslint-disable max-lines -- Why: notebook editing, output rendering, and cell
controls share one parsed document/update path for this first notebook editor
slice; splitting before the model stabilizes would make save/run mutations
harder to audit. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import DOMPurify from 'dompurify'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpToLine,
  Braces,
  FileCode2,
  Loader2,
  MoveDown,
  MoveUp,
  Play,
  Save,
  Trash2
} from 'lucide-react'
import { monaco } from '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { getConnectionId } from '@/lib/connection-context'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { useAppStore } from '@/store'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { registerPendingEditorFlush } from './editor-pending-flush'
import MonacoCodeExcerpt from './MonacoCodeExcerpt'
import {
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  parseIpynb,
  updateIpynbCellKind,
  updateIpynbCellOutputs,
  updateIpynbCellSources,
  type IpynbCell,
  type IpynbCellKind,
  type IpynbOutputItem
} from './ipynb-parse'

type IpynbViewerProps = {
  content: string
  fileId: string
  filePath: string
  worktreeId: string
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => Promise<void>
}

const NOTEBOOK_SOURCE_COMMIT_DELAY_MS = 400

function valueToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '')).join('')
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function dataUriForImage(item: IpynbOutputItem): string | null {
  const value = valueToText(item.value).replace(/\s/g, '')
  if (!value) {
    return null
  }
  if (item.mime === 'image/svg+xml') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(valueToText(item.value))}`
  }
  return `data:${item.mime};base64,${value}`
}

function NotebookCellHeader({
  cell,
  index,
  running,
  canMoveUp,
  canMoveDown,
  onRun,
  onKindChange,
  onInsertAbove,
  onInsertBelow,
  onMoveUp,
  onMoveDown,
  onDelete
}: {
  cell: IpynbCell
  index: number
  running: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onRun: () => void
  onKindChange: (kind: IpynbCellKind) => void
  onInsertAbove: (kind: IpynbCellKind) => void
  onInsertBelow: (kind: IpynbCellKind) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}): React.JSX.Element {
  const Icon = cell.kind === 'code' ? Play : cell.kind === 'markdown' ? FileCode2 : Braces
  const executionLabel = cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : cell.kind
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="font-mono">{executionLabel}</span>
      <select
        value={cell.kind}
        onChange={(event) => onKindChange(event.target.value as IpynbCellKind)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        <option value="code">Code</option>
        <option value="markdown">Markdown</option>
        <option value="raw">Raw</option>
      </select>
      {cell.kind === 'code' ? (
        <NotebookHeaderButton label="Run cell" disabled={running} onClick={onRun}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        </NotebookHeaderButton>
      ) : null}
      <NotebookHeaderButton label="Move cell up" disabled={!canMoveUp} onClick={onMoveUp}>
        <MoveUp className="size-3.5" />
      </NotebookHeaderButton>
      <NotebookHeaderButton label="Move cell down" disabled={!canMoveDown} onClick={onMoveDown}>
        <MoveDown className="size-3.5" />
      </NotebookHeaderButton>
      <NotebookHeaderButton label="Insert code cell above" onClick={() => onInsertAbove('code')}>
        <ArrowUpToLine className="size-3.5" />
      </NotebookHeaderButton>
      <NotebookHeaderButton label="Insert code cell below" onClick={() => onInsertBelow('code')}>
        <ArrowDownToLine className="size-3.5" />
      </NotebookHeaderButton>
      <NotebookHeaderButton
        label="Insert markdown cell above"
        onClick={() => onInsertAbove('markdown')}
      >
        <span className="relative size-4">
          <FileCode2 className="absolute left-0.5 top-0.5 size-3" />
          <MoveUp className="absolute -right-0.5 -top-0.5 size-2.5" />
        </span>
      </NotebookHeaderButton>
      <NotebookHeaderButton
        label="Insert markdown cell below"
        onClick={() => onInsertBelow('markdown')}
      >
        <span className="relative size-4">
          <FileCode2 className="absolute left-0.5 top-0.5 size-3" />
          <MoveDown className="absolute -bottom-0.5 -right-0.5 size-2.5" />
        </span>
      </NotebookHeaderButton>
      <NotebookHeaderButton label="Delete cell" onClick={onDelete}>
        <Trash2 className="size-3.5" />
      </NotebookHeaderButton>
      <span className="ml-auto font-mono">#{index + 1}</span>
    </div>
  )
}

function NotebookHeaderButton({
  label,
  disabled = false,
  shortcutKeys,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  shortcutKeys?: string[]
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-2">
          <span>{label}</span>
          {shortcutKeys ? <ShortcutKeyCombo keys={shortcutKeys} /> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function MarkdownCell({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown-preview-body px-4 py-3 text-sm">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
        {source || '\u00a0'}
      </Markdown>
    </div>
  )
}

function CodeCell({
  cell,
  source,
  active,
  onActivate,
  onDeactivate,
  onChange,
  onSaveRequest
}: {
  cell: IpynbCell
  source: string
  active: boolean
  onActivate: () => void
  onDeactivate: () => void
  onChange: (source: string) => void
  onSaveRequest: () => Promise<void>
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const onDeactivateRef = useRef(onDeactivate)
  const onSaveRequestRef = useRef(onSaveRequest)
  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const lineCount = Math.max(3, source.split('\n').length + 1)
  const editorHeight = Math.min(520, Math.max(96, lineCount * (fontSize + 8)))
  const isDark = resolveDocumentTheme(settings?.theme ?? 'system')
  const lines = useMemo(
    () => (source.length > 0 ? source.replace(/\n$/, '').split('\n') : ['']),
    [source]
  )
  const handleMount: OnMount = useCallback((editorInstance, monacoInstance) => {
    editorInstance.focus()
    editorInstance.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      void onSaveRequestRef.current()
    })
    editorInstance.addCommand(monacoInstance.KeyCode.Escape, () => {
      onDeactivateRef.current()
    })
    editorInstance.onDidBlurEditorWidget(() => {
      onDeactivateRef.current()
    })
  }, [])

  useEffect(() => {
    onDeactivateRef.current = onDeactivate
    onSaveRequestRef.current = onSaveRequest
  }, [onDeactivate, onSaveRequest])

  useEffect(() => {
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
  }, [isDark])

  if (!active) {
    return (
      <div
        role="button"
        tabIndex={0}
        className="block w-full cursor-text bg-editor-surface text-left"
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onActivate()
          }
        }}
      >
        <MonacoCodeExcerpt
          lines={lines}
          firstLineNumber={1}
          highlightedStartLine={-1}
          highlightedEndLine={-1}
          language={cell.language}
        />
      </div>
    )
  }

  return (
    <div className="bg-editor-surface focus-within:ring-1 focus-within:ring-ring">
      <Editor
        height={editorHeight}
        defaultLanguage={cell.language}
        language={cell.language}
        theme={isDark ? 'vs-dark' : 'vs'}
        value={source}
        onMount={handleMount}
        onChange={(value) => onChange(value ?? '')}
        options={{
          automaticLayout: true,
          fontFamily: settings?.terminalFontFamily || 'monospace',
          fontSize,
          glyphMargin: false,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          wordWrap: 'off'
        }}
      />
    </div>
  )
}

const MemoizedCodeCell = React.memo(CodeCell)

function getCellKey(cell: IpynbCell, index: number): string {
  return cell.id ?? `${index}:${cell.kind}`
}

function hasOwnDraft(drafts: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(drafts, key)
}

function EditableTextCell({
  source,
  onChange
}: {
  source: string
  onChange: (source: string) => void
}): React.JSX.Element {
  return (
    <textarea
      value={source}
      onChange={(event) => onChange(event.target.value)}
      className="block min-h-24 w-full resize-y border-0 bg-background px-4 py-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

function PreformattedOutput({
  text,
  error = false
}: {
  text: string
  error?: boolean
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-[420px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5',
        error ? 'text-destructive' : 'text-foreground'
      )}
    >
      {text}
    </pre>
  )
}

function OutputItem({ item }: { item: IpynbOutputItem }): React.JSX.Element | null {
  if (item.mime === 'text/html') {
    const html = DOMPurify.sanitize(valueToText(item.value), {
      USE_PROFILES: { html: true, svg: true, svgFilters: true }
    })
    return (
      <iframe
        title="Notebook HTML output"
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className="block h-80 w-full border-0 bg-background"
        srcDoc={html}
      />
    )
  }

  if (item.mime.startsWith('image/')) {
    const uri = dataUriForImage(item)
    if (!uri) {
      return null
    }
    return (
      <div className="flex max-w-full overflow-auto p-3">
        <img src={uri} alt={item.mime} className="max-h-[520px] max-w-full object-contain" />
      </div>
    )
  }

  if (item.mime === 'application/json' || item.mime.endsWith('+json')) {
    const text =
      typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null, null, 2)
    return <PreformattedOutput text={text} />
  }

  if (item.mime === 'text/markdown') {
    return <MarkdownCell source={valueToText(item.value)} />
  }

  if (item.mime.startsWith('text/') || item.mime === 'application/javascript') {
    return <PreformattedOutput text={valueToText(item.value)} />
  }

  return null
}

function CellOutputs({ cell }: { cell: IpynbCell }): React.JSX.Element | null {
  if (cell.outputs.length === 0) {
    return null
  }

  return (
    <div className="border-t border-border/50 bg-background">
      {cell.outputs.map((output, index) => {
        if (output.kind === 'stream') {
          return <PreformattedOutput key={index} text={output.text} />
        }
        if (output.kind === 'error') {
          return (
            <div key={index} className="border-l-2 border-destructive">
              <PreformattedOutput
                error
                text={[output.name, output.message, output.traceback].filter(Boolean).join('\n')}
              />
            </div>
          )
        }
        const renderedItems = output.items
          .map((item, itemIndex) => <OutputItem key={`${item.mime}-${itemIndex}`} item={item} />)
          .filter(Boolean)
        if (renderedItems.length === 0) {
          return null
        }
        return (
          <div key={index} className="border-b border-border/40 last:border-b-0">
            {renderedItems}
          </div>
        )
      })}
    </div>
  )
}

export default function IpynbViewer({
  content,
  fileId,
  filePath,
  worktreeId,
  scrollCacheKey,
  onContentChange,
  onDirtyStateHint,
  onSave
}: IpynbViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const [runningCellIndex, setRunningCellIndex] = useState<number | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const [executionTrustedForFile, setExecutionTrustedForFile] = useState(false)
  const [pendingRunCellIndex, setPendingRunCellIndex] = useState<number | null>(null)
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({})
  const sourceDraftsRef = useRef(sourceDrafts)
  const contentRef = useRef(content)
  const notebookRef = useRef<ReturnType<typeof parseIpynb> | null>(null)
  const onContentChangeRef = useRef(onContentChange)
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const sourceCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fontSize = computeEditorFontSize(13, editorFontZoomLevel)
  const parsed = useMemo(() => {
    try {
      return { notebook: parseIpynb(content), error: null as string | null }
    } catch (error) {
      return {
        notebook: null,
        error: error instanceof Error ? error.message : 'Invalid notebook'
      }
    }
  }, [content])
  contentRef.current = content
  notebookRef.current = parsed.notebook
  onContentChangeRef.current = onContentChange
  onDirtyStateHintRef.current = onDirtyStateHint

  const materializeSourceDrafts = useCallback((): string => {
    const notebook = notebookRef.current
    const drafts = sourceDraftsRef.current
    if (!notebook || Object.keys(drafts).length === 0) {
      return contentRef.current
    }
    const updates = notebook.cells
      .map((cell, index) => {
        const key = getCellKey(cell, index)
        return hasOwnDraft(drafts, key) ? { index, source: drafts[key] ?? '' } : null
      })
      .filter((update): update is { index: number; source: string } => update !== null)
    return updateIpynbCellSources(contentRef.current, updates)
  }, [])

  const flushSourceDrafts = useCallback((): string => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
      sourceCommitTimerRef.current = null
    }
    const nextContent = materializeSourceDrafts()
    if (nextContent !== contentRef.current) {
      contentRef.current = nextContent
      onContentChangeRef.current(nextContent)
    }
    return nextContent
  }, [materializeSourceDrafts])

  const queueSourceDraftCommit = useCallback((): void => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
    }
    sourceCommitTimerRef.current = setTimeout(() => {
      void flushSourceDrafts()
    }, NOTEBOOK_SOURCE_COMMIT_DELAY_MS)
  }, [flushSourceDrafts])

  useEffect(() => {
    return registerPendingEditorFlush(fileId, flushSourceDrafts)
  }, [fileId, flushSourceDrafts])

  useEffect(() => {
    setExecutionTrustedForFile(false)
    setPendingRunCellIndex(null)
  }, [filePath])

  useEffect(() => {
    return () => {
      void flushSourceDrafts()
    }
  }, [flushSourceDrafts])

  useEffect(() => {
    if (!parsed.notebook || Object.keys(sourceDraftsRef.current).length === 0) {
      return
    }
    const nextDrafts = { ...sourceDraftsRef.current }
    let changed = false
    parsed.notebook.cells.forEach((cell, index) => {
      const key = getCellKey(cell, index)
      if (hasOwnDraft(nextDrafts, key) && nextDrafts[key] === cell.source) {
        delete nextDrafts[key]
        changed = true
      }
    })
    if (changed) {
      sourceDraftsRef.current = nextDrafts
      setSourceDrafts(nextDrafts)
    }
  }, [parsed.notebook])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }
    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }
    container.scrollTop = targetScrollTop
  }, [scrollCacheKey, content])

  const saveNotebook = useCallback(async (): Promise<void> => {
    const latestContent = flushSourceDrafts()
    await onSave(latestContent)
  }, [flushSourceDrafts, onSave])

  const handleNotebookKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const isMac = navigator.userAgent.includes('Mac')
      const hasSaveModifier = isMac ? event.metaKey : event.ctrlKey
      if (!hasSaveModifier || event.shiftKey || event.repeat || event.key.toLowerCase() !== 's') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void saveNotebook()
    },
    [saveNotebook]
  )

  const handleNotebookPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (editingCellKey === null) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.monaco-editor')) {
        return
      }
      setEditingCellKey(null)
    },
    [editingCellKey]
  )

  if (parsed.error || !parsed.notebook) {
    return (
      <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
        <div className="flex max-w-md items-start gap-3 rounded-md border border-border bg-background p-4">
          <AlertCircle className="mt-0.5 size-4 text-destructive" />
          <div>
            <div className="font-medium text-foreground">Unable to render notebook</div>
            <div className="mt-1">{parsed.error}</div>
          </div>
        </div>
      </div>
    )
  }

  const { notebook } = parsed
  const shortcutModifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
  const applyContent = (nextContent: string): void => {
    contentRef.current = nextContent
    onContentChange(nextContent)
  }
  const updateCellSource = (index: number, source: string): void => {
    const cell = notebook.cells[index]
    if (!cell) {
      return
    }
    const key = getCellKey(cell, index)
    const nextDrafts = { ...sourceDraftsRef.current, [key]: source }
    sourceDraftsRef.current = nextDrafts
    setSourceDrafts(nextDrafts)
    onDirtyStateHintRef.current(true)
    queueSourceDraftCommit()
  }
  const applyStructuralContentChange = (
    getNextContent: (latestContent: string) => string
  ): void => {
    const latestContent = flushSourceDrafts()
    // Why: Monaco can still have a render frame queued for the active cell.
    // Exit edit mode first, then reorder/replace cells on the next frame so
    // structural notebook actions do not dispose an editor mid-render.
    setEditingCellKey(null)
    requestAnimationFrame(() => {
      applyContent(getNextContent(latestContent))
    })
  }
  const updateCellKind = (index: number, kind: IpynbCellKind): void => {
    applyStructuralContentChange((latestContent) =>
      updateIpynbCellKind(latestContent, index, kind, notebook.language)
    )
  }
  const insertCell = (index: number, kind: IpynbCellKind): void => {
    applyStructuralContentChange((latestContent) =>
      insertIpynbCell(latestContent, index, kind, notebook.language)
    )
  }
  const moveCell = (index: number, direction: -1 | 1): void => {
    applyStructuralContentChange((latestContent) => moveIpynbCell(latestContent, index, direction))
  }
  const deleteCell = (index: number): void => {
    applyStructuralContentChange((latestContent) => deleteIpynbCell(latestContent, index))
  }
  const runCell = async (
    index: number,
    options: { skipTrustPrompt?: boolean } = {}
  ): Promise<void> => {
    const latestContent = flushSourceDrafts()
    const latestNotebook = parseIpynb(latestContent)
    const cell = latestNotebook.cells[index]
    if (!cell || cell.kind !== 'code' || runningCellIndex !== null) {
      return
    }
    if (!executionTrustedForFile && !options.skipTrustPrompt) {
      setPendingRunCellIndex(index)
      return
    }
    setRunError(null)
    setRunningCellIndex(index)
    try {
      await onSave(latestContent)
      const result = await window.api.notebook.runPythonCell({
        filePath,
        code: cell.source,
        preamble: latestNotebook.cells
          .slice(0, index)
          .filter((previousCell) => previousCell.kind === 'code')
          .map((previousCell) => previousCell.source)
          .join('\n\n'),
        connectionId: getConnectionId(worktreeId) ?? undefined
      })
      applyContent(updateIpynbCellOutputs(latestContent, index, result))
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunningCellIndex(null)
    }
  }
  const cancelPendingRun = (): void => setPendingRunCellIndex(null)
  const confirmPendingRun = (): void => {
    const index = pendingRunCellIndex
    setPendingRunCellIndex(null)
    setExecutionTrustedForFile(true)
    if (index !== null) {
      void runCell(index, { skipTrustPrompt: true })
    }
  }

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0 overflow-auto bg-editor-surface scrollbar-editor"
      style={{ fontSize, fontFamily: settings?.terminalFontFamily || undefined }}
      onKeyDownCapture={handleNotebookKeyDownCapture}
      onPointerDownCapture={handleNotebookPointerDownCapture}
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="font-medium text-foreground">{filePath.split(/[/\\]/).pop()}</span>
        <span>{notebook.cells.length} cells</span>
        <span>{notebook.language}</span>
        {notebook.kernelName ? <span>{notebook.kernelName}</span> : null}
        {runError ? <span className="text-destructive">{runError}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <NotebookHeaderButton
            label="Save notebook"
            shortcutKeys={[shortcutModifier, 'S']}
            onClick={() => void saveNotebook()}
          >
            <Save className="size-3.5" />
          </NotebookHeaderButton>
          <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            BETA
          </span>
          <span className="font-mono">nbformat {notebook.nbformat}</span>
        </div>
      </div>
      <div className="mx-auto flex max-w-[980px] flex-col gap-3 px-5 py-5">
        {notebook.cells.length === 0 ? (
          <div className="flex items-center justify-center rounded-md border border-border bg-background p-8 text-sm text-muted-foreground">
            Empty notebook
          </div>
        ) : (
          notebook.cells.map((cell, index) => {
            const cellKey = getCellKey(cell, index)
            const source = hasOwnDraft(sourceDrafts, cellKey)
              ? (sourceDrafts[cellKey] ?? '')
              : cell.source
            return (
              <section
                key={cellKey}
                className="overflow-hidden rounded-md border border-border bg-background"
              >
                <NotebookCellHeader
                  cell={cell}
                  index={index}
                  running={runningCellIndex === index}
                  canMoveUp={index > 0}
                  canMoveDown={index < notebook.cells.length - 1}
                  onRun={() => void runCell(index)}
                  onKindChange={(kind) => updateCellKind(index, kind)}
                  onInsertAbove={(kind) => insertCell(index, kind)}
                  onInsertBelow={(kind) => insertCell(index + 1, kind)}
                  onMoveUp={() => moveCell(index, -1)}
                  onMoveDown={() => moveCell(index, 1)}
                  onDelete={() => deleteCell(index)}
                />
                {cell.kind === 'markdown' ? (
                  <div className="grid gap-0 lg:grid-cols-2">
                    <EditableTextCell
                      source={source}
                      onChange={(nextSource) => updateCellSource(index, nextSource)}
                    />
                    <div className="border-t border-border/50 lg:border-l lg:border-t-0">
                      <MarkdownCell source={source} />
                    </div>
                  </div>
                ) : cell.kind === 'code' ? (
                  <MemoizedCodeCell
                    cell={cell}
                    source={source}
                    active={editingCellKey === cellKey}
                    onActivate={() => setEditingCellKey(cellKey)}
                    onDeactivate={() =>
                      setEditingCellKey((current) => (current === cellKey ? null : current))
                    }
                    onChange={(nextSource) => updateCellSource(index, nextSource)}
                    onSaveRequest={saveNotebook}
                  />
                ) : (
                  <EditableTextCell
                    source={source}
                    onChange={(nextSource) => updateCellSource(index, nextSource)}
                  />
                )}
                <CellOutputs cell={cell} />
              </section>
            )
          })
        )}
      </div>
      <Dialog
        open={pendingRunCellIndex !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelPendingRun()
          }
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Run Notebook Code?</DialogTitle>
            <DialogDescription className="text-xs">
              Notebook cells execute local Python on this machine from the notebook folder. Only run
              cells from files you trust.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={cancelPendingRun}>
              Cancel
            </Button>
            <Button type="button" size="sm" autoFocus onClick={confirmPendingRun}>
              Run cell
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
