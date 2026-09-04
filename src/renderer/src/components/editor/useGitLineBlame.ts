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
import { blameLineByNumber, type GitBlameResult } from '../../../../shared/git-blame'
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
  widgetKey?: string
}): void {
  const {
    editor: editorInstance,
    enabled,
    worktreeId,
    relativePath,
    revision,
    widgetKey = 'file'
  } = args
  const head = useAppStore((state) =>
    worktreeId ? (state.gitStatusHeadByWorktree[worktreeId] ?? null) : null
  )
  const blameRef = useRef<GitBlameResult | null>(null)
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
      const blameLine = blameLineByNumber(blameRef.current?.lines ?? [], lineNumber)
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
    let debounce: ReturnType<typeof setTimeout> | null = null
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
        void getRuntimeGitBlame(
          {
            settings: getRepoOwnerRoutedSettings(state.settings, repo),
            worktreeId,
            worktreePath,
            connectionId: getConnectionId(worktreeId) ?? undefined
          },
          relativePath,
          revision
        )
          .then((result) => {
            if (cancelled) {
              return
            }
            blameRef.current = result
            renderLine(lineRef.current)
          })
          .catch(() => {
            if (cancelled) {
              return
            }
            blameRef.current = { status: 'unavailable', lines: [] }
            hide()
          })
      }, BLAME_FETCH_DEBOUNCE_MS)
    }

    const onAnnotationMouseDown = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const blameLine = blameLineByNumber(blameRef.current?.lines ?? [], lineRef.current)
      if (!blameLine) {
        return
      }
      void openGitBlameCommitDiff(worktreeId, blameLine)
    }
    node.addEventListener('mousedown', onAnnotationMouseDown)

    load()
    const cursorSub = editorInstance.onDidChangeCursorPosition((event) => {
      renderLine(event.position.lineNumber)
    })
    const contentSub = editorInstance.onDidChangeModelContent(() => {
      renderLine(lineRef.current)
    })
    const configSub = editorInstance.onDidChangeConfiguration(() => {
      renderLine(lineRef.current)
    })

    return () => {
      cancelled = true
      if (debounce) {
        clearTimeout(debounce)
      }
      node.removeEventListener('mousedown', onAnnotationMouseDown)
      cursorSub.dispose()
      contentSub.dispose()
      configSub.dispose()
      editorInstance.removeContentWidget(widget)
    }
  }, [editorInstance, enabled, head, relativePath, revision, widgetKey, worktreeId])
}
