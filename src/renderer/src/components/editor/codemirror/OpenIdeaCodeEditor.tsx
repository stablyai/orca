import React, { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightSelectionMatches } from '@codemirror/search'
import type { MarkdownDocument } from '../../../../../shared/file-listing/file-document'
import { resolveFileEditorWordWrap } from '../../../../../shared/editor/editor-typography'
import { useDocumentDarkTheme } from '@/hooks/theme/use-document-dark-theme'
import { useTranslate } from '@/i18n/use-translate'
import { useEditorTypography } from '@/lib/editor/appearance/use-editor-typography'
import type { WorkspaceResource } from '@/lib/workspace/ownership/workspace-copy-owner'
import { useCodeEditorThemeStore } from '@/store/appearance/code-editor-theme'
import { useAppStore } from '@/store/index'
import {
  normalizeDebugPathKey,
  resolveWorkspaceRootForFile
} from '@/store/debug/debug-session-paths'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'
import { createConflictDecorationsExtension } from './codemirror-conflict-decorations'
import { LARGE_FILE_HIGHLIGHT_LIMIT, resolveCodeMirrorLanguage } from './codemirror-languages'
import { createOpenIdeaTheme } from './codemirror-theme'
import {
  computeRevealSelectionRange,
  installCodeMirrorScrollTracking,
  restoreCodeMirrorViewState,
  snapshotCodeMirrorViewState
} from './codemirror-view-state'
import { externalSyncAnnotation, type BreakpointPopoverRequest } from './breakpoint-gutter'
import { createCodeIntelExtensionBundle } from './codemirror-code-intel-bundle'
import { notifyLspDidSave } from './code-lsp-sync'
import { runCodeEditorClipboardCommand, triggerCodeAction } from './code-navigation-actions'
import {
  createCodeMirrorDebugExtensions,
  createSaveAndDebugKeymap,
  triggerSmartStepFromEditorView
} from './debug-editor-keymap'
import type { DebugValueInspectRequest } from './debug-inline-values'
import { CodeIntelligenceOverlays } from '../code-intelligence/CodeIntelligenceOverlays'
import { EditorDebugBar } from '../debug/EditorDebugBar'

type OpenIdeaCodeEditorProps = {
  fileId: string
  filePath: string
  viewStateKey: string
  viewStateId?: string
  relativePath: string
  content: string
  language: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
  revealLine?: number
  revealColumn?: number
  revealMatchLength?: number
  markdownDocuments?: MarkdownDocument[]
  worktreeId?: string
  noteSource?: WorkspaceResource
  markdownAnnotationsEnabled?: boolean
  conflictDecorationsEnabled?: boolean
  readOnly?: boolean
  passiveMirror?: boolean
  liveTail?: boolean
  autoHeight?: boolean
}

export default function OpenIdeaCodeEditor({
  fileId,
  filePath,
  viewStateKey,
  relativePath,
  content,
  language,
  onContentChange,
  onSave,
  revealLine,
  revealColumn,
  revealMatchLength,
  worktreeId,
  conflictDecorationsEnabled = false,
  readOnly = false,
  passiveMirror = false,
  liveTail = false,
  autoHeight = false
}: OpenIdeaCodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const themeCompartmentRef = useRef(new Compartment())
  const readOnlyCompartmentRef = useRef(new Compartment())
  const wrapCompartmentRef = useRef(new Compartment())
  const conflictCompartmentRef = useRef(new Compartment())
  const matchHighlightCompartmentRef = useRef(new Compartment())
  const suppressExternalSyncRef = useRef(false)
  const [bpPopover, setBpPopover] = useState<BreakpointPopoverRequest | null>(null)
  const [valueInspect, setValueInspect] = useState<
    (DebugValueInspectRequest & { filePath: string }) | null
  >(null)

  const t = useTranslate()
  const typography = useEditorTypography()
  const documentDark = useDocumentDarkTheme()
  const editorBase = useCodeEditorThemeStore((s) => s.override?.base)
  const isDark = editorBase ? editorBase === 'dark' : documentDark
  const editorWordWrap = useAppStore(
    (s) => resolveFileEditorWordWrap(s.settings?.editorWordWrap) === 'on'
  )
  const isLargeFile = content.length > LARGE_FILE_HIGHLIGHT_LIMIT
  const fileKey = normalizeDebugPathKey(filePath)
  const workspaceRoot = resolveWorkspaceRootForFile(filePath, relativePath, worktreeId)
  const runToCursorTitle = t('auto.components.editor.debug.runToCursorTitle', 'Run to Cursor')
  const resumeProgramTitle = t('auto.components.editor.debug.resumeProgramTitle', 'Resume Program')

  // Why: the mount effect reads latest snapshots through propsRef so filePath/fileKey/viewStateKey stay sole deps.
  const propsRef = useRef({
    fileId,
    filePath,
    fileKey,
    workspaceRoot,
    content,
    language,
    typography,
    isDark,
    editorWordWrap,
    conflictDecorationsEnabled,
    isLargeFile,
    autoHeight,
    readOnly,
    passiveMirror,
    liveTail,
    revealLine,
    runToCursorTitle,
    resumeProgramTitle,
    onContentChange,
    onSave
  })
  useEffect(() => {
    propsRef.current = {
      fileId,
      filePath,
      fileKey,
      workspaceRoot,
      content,
      language,
      typography,
      isDark,
      editorWordWrap,
      conflictDecorationsEnabled,
      isLargeFile,
      autoHeight,
      readOnly,
      passiveMirror,
      liveTail,
      revealLine,
      runToCursorTitle,
      resumeProgramTitle,
      onContentChange,
      onSave
    }
  })

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) {
      return
    }

    const saveAndDebugKeymap = createSaveAndDebugKeymap(() => ({
      filePath: propsRef.current.filePath,
      fileKey: propsRef.current.fileKey,
      readOnly: propsRef.current.readOnly,
      onSave: (saved) => {
        notifyLspDidSave(propsRef.current.filePath, saved)
        propsRef.current.onSave(saved)
      }
    }))

    const handleInspectValue = (req: DebugValueInspectRequest): void => {
      setValueInspect({ ...req, filePath: propsRef.current.filePath })
    }

    const getNavCtx = () => ({
      filePath: propsRef.current.filePath,
      fileKey: propsRef.current.fileKey,
      workspaceRoot: propsRef.current.workspaceRoot,
      language: propsRef.current.language,
      readOnly: propsRef.current.readOnly
    })

    const interactive = !propsRef.current.passiveMirror && !propsRef.current.autoHeight
    const debugExtensions: Extension[] = interactive
      ? createCodeMirrorDebugExtensions({
          filePath: propsRef.current.filePath,
          fileKey,
          runToCursor: propsRef.current.runToCursorTitle,
          resume: propsRef.current.resumeProgramTitle,
          onOpenBreakpointPopover: (req) => setBpPopover(req),
          onInspectValue: handleInspectValue
        })
      : []

    const codeIntelExtensions = createCodeIntelExtensionBundle(interactive, getNavCtx)

    const mountContentLen = propsRef.current.isLargeFile ? LARGE_FILE_HIGHLIGHT_LIMIT + 1 : 0
    const state = EditorState.create({
      doc: propsRef.current.content,
      extensions: [
        ...debugExtensions,
        ...codeIntelExtensions,
        saveAndDebugKeymap,
        languageCompartmentRef.current.of(
          resolveCodeMirrorLanguage(
            propsRef.current.language,
            propsRef.current.filePath,
            mountContentLen
          )
        ),
        themeCompartmentRef.current.of(
          createOpenIdeaTheme(
            propsRef.current.typography,
            propsRef.current.autoHeight,
            propsRef.current.isDark
          )
        ),
        readOnlyCompartmentRef.current.of([
          EditorState.readOnly.of(propsRef.current.readOnly),
          EditorView.editable.of(!propsRef.current.readOnly)
        ]),
        wrapCompartmentRef.current.of(
          propsRef.current.editorWordWrap ? EditorView.lineWrapping : []
        ),
        conflictCompartmentRef.current.of(
          createConflictDecorationsExtension(propsRef.current.conflictDecorationsEnabled)
        ),
        matchHighlightCompartmentRef.current.of(
          propsRef.current.isLargeFile ? [] : highlightSelectionMatches()
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressExternalSyncRef.current && !propsRef.current.readOnly) {
            propsRef.current.onContentChange(update.state.doc.toString())
          }
          if (update.selectionSet && !propsRef.current.passiveMirror) {
            const head = update.state.selection.main.head
            const lineInfo = update.state.doc.lineAt(head)
            useAppStore.getState().setEditorCursorLine(propsRef.current.fileId, lineInfo.number)
            useCodeIntelligenceStore
              .getState()
              .recordCursorPlace(
                propsRef.current.filePath,
                lineInfo.number,
                head - lineInfo.from + 1
              )
          }
        })
      ]
    })

    const view = new EditorView({ state, parent })
    viewRef.current = view

    const stopScrollTracking = propsRef.current.autoHeight
      ? () => {}
      : installCodeMirrorScrollTracking(view, viewStateKey)
    restoreCodeMirrorViewState(
      view,
      viewStateKey,
      !propsRef.current.autoHeight && !propsRef.current.revealLine && !propsRef.current.liveTail
    )
    if (propsRef.current.liveTail && !propsRef.current.autoHeight) {
      requestAnimationFrame(() => {
        if (view.dom.isConnected) {
          view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
        }
      })
    }

    return () => {
      stopScrollTracking()
      snapshotCodeMirrorViewState(view, viewStateKey)
      viewRef.current = null
      view.destroy()
    }
    // Mount fresh instance per file/container; subsequent prop updates use compartments.
    // fileKey derives from filePath, so listing both keeps the mount semantics.
  }, [filePath, fileKey, viewStateKey])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const currentText = view.state.doc.toString()
    if (content !== currentText) {
      const scroller = view.scrollDOM
      const wasNearBottom =
        liveTail &&
        !autoHeight &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48
      suppressExternalSyncRef.current = true
      view.dispatch({
        changes: { from: 0, to: currentText.length, insert: content },
        annotations: externalSyncAnnotation.of(true)
      })
      suppressExternalSyncRef.current = false
      if (wasNearBottom) {
        requestAnimationFrame(() => {
          if (view.dom.isConnected) {
            view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
          }
        })
      }
    }
  }, [autoHeight, content, liveTail])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const lengthHint = isLargeFile ? LARGE_FILE_HIGHLIGHT_LIMIT + 1 : 0
    view.dispatch({
      effects: [
        languageCompartmentRef.current.reconfigure(
          resolveCodeMirrorLanguage(language, filePath, lengthHint)
        ),
        themeCompartmentRef.current.reconfigure(
          createOpenIdeaTheme(typography, autoHeight, isDark)
        ),
        readOnlyCompartmentRef.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly)
        ]),
        wrapCompartmentRef.current.reconfigure(editorWordWrap ? EditorView.lineWrapping : []),
        conflictCompartmentRef.current.reconfigure(
          createConflictDecorationsExtension(conflictDecorationsEnabled)
        ),
        matchHighlightCompartmentRef.current.reconfigure(
          isLargeFile ? [] : highlightSelectionMatches()
        )
      ]
    })
  }, [
    autoHeight,
    conflictDecorationsEnabled,
    editorWordWrap,
    filePath,
    isDark,
    isLargeFile,
    language,
    readOnly,
    typography
  ])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !revealLine || revealLine < 1) {
      return
    }
    const range = computeRevealSelectionRange(
      view.state.doc,
      revealLine,
      revealColumn,
      revealMatchLength
    )
    view.dispatch({
      selection: range,
      effects: EditorView.scrollIntoView(range.anchor, { y: 'center' })
    })
    if (!passiveMirror) {
      view.focus()
      useAppStore.getState().setPendingEditorReveal(null)
    }
  }, [passiveMirror, revealColumn, revealLine, revealMatchLength])

  const runContextCommand = (command: 'cut' | 'copy' | 'paste' | 'select-all'): void => {
    runCodeEditorClipboardCommand(viewRef.current, readOnly, command)
  }

  const showDebugBar = !readOnly && !passiveMirror && !autoHeight

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      <CodeIntelligenceOverlays
        filePath={filePath}
        workspaceRoot={workspaceRoot}
        bpPopover={bpPopover}
        valueInspect={valueInspect}
        onCloseBpPopover={() => setBpPopover(null)}
        onCloseValueInspect={() => setValueInspect(null)}
        onRunContextCommand={runContextCommand}
      />
      {showDebugBar ? (
        <EditorDebugBar
          filePath={filePath}
          relativePath={relativePath}
          worktreeId={worktreeId}
          language={language}
          onOpenOutline={() => {
            const view = viewRef.current
            if (view) {
              triggerCodeAction(view, { filePath, workspaceRoot, language, readOnly }, 'outline')
            }
          }}
          onSmartStepInto={() => triggerSmartStepFromEditorView(viewRef.current, fileKey)}
        />
      ) : null}
    </div>
  )
}
