import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { monaco } from '@/lib/monaco-setup'
import { openGitBlameCommitDiff } from '@/lib/open-git-blame-commit-diff'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getRuntimeGitBlame } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'
import {
  indexBlameLinesByNumber,
  type GitBlameContentsSource,
  type GitBlameLineIndex
} from '../../../../shared/git-blame'
import { enqueueGitBlameRequest } from '@/lib/git-blame-request-queue'
import {
  buildGitLineBlameWidgetModel,
  GIT_LINE_BLAME_INLINE_CLASS
} from './git-line-blame-decorations'

const BLAME_FETCH_DEBOUNCE_MS = 80

export function useGitLineBlame(args: {
  editor: editor.ICodeEditor | editor.IStandaloneCodeEditor | null
  enabled: boolean
  worktreeId?: string
  relativePath: string
  revision?: string
  contentsSource?: GitBlameContentsSource
  widgetKey?: string
}): void {
  const {
    editor: editorInstance,
    enabled,
    worktreeId,
    relativePath,
    revision,
    contentsSource,
    widgetKey = 'file'
  } = args
  const head = useAppStore((state) =>
    worktreeId ? (state.gitStatusHeadByWorktree[worktreeId] ?? null) : null
  )
  const blameRef = useRef<GitBlameLineIndex | null>(null)
  const lineRef = useRef(1)

  useEffect(() => {
    if (!editorInstance || !enabled || !worktreeId || relativePath.length === 0) {
      blameRef.current = null
      return
    }

    const uncommittedLabel = translate(
      'auto.components.editor.gitLineBlame.uncommittedLabel',
      'Not Committed Yet'
    )
    const node = document.createElement('div')
    node.className = GIT_LINE_BLAME_INLINE_CLASS
    node.style.display = 'none'
    let widgetPosition: editor.IContentWidgetPosition | null = null
    const widget: editor.IContentWidget = {
      // Why: overflow widgets are clamped into the viewport, which slides a
      // long annotation to the editor's left edge instead of keeping it at EOL.
      allowEditorOverflow: false,
      suppressMouseDown: true,
      getId: () => `orca.git-line-blame.${widgetKey}.${worktreeId}.${relativePath}`,
      getDomNode: () => node,
      getPosition: () => widgetPosition
    }
    editorInstance.addContentWidget(widget)

    const hide = (): void => {
      node.style.display = 'none'
      node.textContent = ''
      widgetPosition = null
      editorInstance.layoutContentWidget(widget)
    }

    const renderLine = (lineNumber: number): void => {
      lineRef.current = lineNumber
      const blameLine = blameRef.current?.get(lineNumber) ?? null
      const model = editorInstance.getModel()
      if (!blameLine || !model) {
        hide()
        return
      }
      const widgetModel = buildGitLineBlameWidgetModel(blameLine, model.getLineCount(), {
        uncommittedLabel,
        endColumn: model.getLineMaxColumn(lineNumber)
      })
      if (!widgetModel) {
        hide()
        return
      }
      const fontInfo = editorInstance.getOption(monaco.editor.EditorOption.fontInfo)
      const lineHeight = editorInstance.getOption(monaco.editor.EditorOption.lineHeight)
      node.textContent = widgetModel.text
      node.style.display = 'block'
      node.style.height = `${lineHeight}px`
      node.style.fontFamily = fontInfo.fontFamily
      node.style.fontSize = `${Math.max(11, fontInfo.fontSize - 1)}px`
      node.style.lineHeight = `${lineHeight}px`
      widgetPosition = {
        position: { lineNumber, column: widgetModel.column },
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        positionAffinity: monaco.editor.PositionAffinity.Right
      }
      editorInstance.layoutContentWidget(widget)
    }

    const position = editorInstance.getPosition()
    if (position) {
      lineRef.current = position.lineNumber
    }

    let cancelled = false
    let fetchGeneration = 0
    let debounce: ReturnType<typeof setTimeout> | null = null
    let queued: { cancel: () => void; promote: () => void } | null = null
    const dropPendingFetch = (): void => {
      fetchGeneration += 1
      if (debounce) {
        clearTimeout(debounce)
        debounce = null
      }
      queued?.cancel()
      queued = null
    }
    const load = (): void => {
      if (debounce) {
        clearTimeout(debounce)
      }
      debounce = setTimeout(() => {
        const state = useAppStore.getState()
        const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
        const worktreePath =
          worktree?.path ?? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
        if (!worktreePath) {
          return
        }
        const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
        const repo = state.repos.find((entry) => entry.id === repoId) ?? null
        queued?.cancel()
        const generation = ++fetchGeneration
        const model = editorInstance.getModel()
        const modelVersion = model?.getAlternativeVersionId()
        const request = enqueueGitBlameRequest(() =>
          getRuntimeGitBlame(
            {
              settings: getRepoOwnerRoutedSettings(state.settings, repo),
              worktreeId,
              worktreePath,
              connectionId: getConnectionId(worktreeId) ?? undefined
            },
            relativePath,
            revision,
            contentsSource
          )
        )
        queued = request
        void request.promise
          .then((result) => {
            if (
              !result ||
              cancelled ||
              generation !== fetchGeneration ||
              editorInstance.getModel() !== model ||
              model?.getAlternativeVersionId() !== modelVersion
            ) {
              return
            }
            blameRef.current = indexBlameLinesByNumber(result.lines)
            renderLine(lineRef.current)
          })
          .catch(() => {
            if (cancelled || generation !== fetchGeneration) {
              return
            }
            blameRef.current = null
            hide()
          })
      }, BLAME_FETCH_DEBOUNCE_MS)
    }

    const onAnnotationMouseDown = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const blameLine = blameRef.current?.get(lineRef.current) ?? null
      if (!blameLine) {
        return
      }
      void openGitBlameCommitDiff(worktreeId, blameLine)
    }
    node.addEventListener('mousedown', onAnnotationMouseDown)

    load()
    const cursorSub = editorInstance.onDidChangeCursorPosition((event) => {
      queued?.promote()
      renderLine(event.position.lineNumber)
    })
    const focusSub = editorInstance.onDidFocusEditorText(() => queued?.promote())
    const contentSub = editorInstance.onDidChangeModelContent(() => {
      // Why: cached blame no longer matches the model, so drop it and drop any in-flight result.
      dropPendingFetch()
      blameRef.current = null
      hide()
      // Why: read-only panes (index/revision models) refresh without saving, so re-blame them; editable buffers wait for save.
      if (editorInstance.getOption(monaco.editor.EditorOption.readOnly)) {
        load()
      }
    })
    // Why: combined diff sections swap models on refresh without remounting the editor.
    const modelSub = editorInstance.onDidChangeModel(() => {
      dropPendingFetch()
      blameRef.current = null
      hide()
      if (editorInstance.getModel()) {
        load()
      }
    })
    const configSub = editorInstance.onDidChangeConfiguration(() => {
      renderLine(lineRef.current)
    })

    return () => {
      cancelled = true
      dropPendingFetch()
      node.removeEventListener('mousedown', onAnnotationMouseDown)
      cursorSub.dispose()
      focusSub.dispose()
      contentSub.dispose()
      modelSub.dispose()
      configSub.dispose()
      editorInstance.removeContentWidget(widget)
    }
  }, [contentsSource, editorInstance, enabled, head, relativePath, revision, widgetKey, worktreeId])
}
