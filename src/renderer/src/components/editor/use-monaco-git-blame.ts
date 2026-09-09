import { useCallback, useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { getRuntimeGitCommitCompare } from '@/runtime/runtime-git-diff-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { getRuntimeGitBlame } from '@/runtime/runtime-git-status-client'
import { getRuntimeGitRemoteCommitUrl } from '@/runtime/runtime-git-working-tree-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { GitBlameRange } from '../../../../shared/git-blame'
import { findGitBlameRangeForLine, formatGitBlameInlineLabel } from './git-blame-current-line'
import { buildGitBlameHoverMarkdown } from './git-blame-hover'
import { getGitBlameErrorMessage } from './git-blame-errors'
import { useGitBlamePreference } from './git-blame-preference'

export type GitBlameDetailsRequest = {
  range: GitBlameRange
  anchorX: number
  anchorY: number
}

type RuntimeContext = Parameters<typeof getRuntimeGitBlame>[0]

export function useMonacoGitBlame(args: {
  editor: editor.IStandaloneCodeEditor | null
  fileId: string
  filePath: string
  worktreeId?: string
  relativePath: string
  dirty: boolean
  contentRevision: string
}): {
  status: string | null
  detailsRequest: GitBlameDetailsRequest | null
  closeDetails: () => void
  copyHash: () => Promise<void>
  openRemoteCommit: () => Promise<void>
  openCommitDiff: () => Promise<void>
} {
  const {
    editor: mountedEditor,
    fileId,
    filePath,
    worktreeId,
    relativePath,
    dirty,
    contentRevision
  } = args
  const [enabled] = useGitBlamePreference(worktreeId ?? '')
  const [status, setStatus] = useState<string | null>(null)
  const [ranges, setRanges] = useState<GitBlameRange[]>([])
  const [detailsRequest, setDetailsRequest] = useState<GitBlameDetailsRequest | null>(null)
  const repositoryHead = useAppStore((state) =>
    worktreeId ? state.gitStatusHeadByWorktree[worktreeId] : undefined
  )
  const generation = useRef(0)
  const runtimeContextRef = useRef<RuntimeContext | null>(null)
  const worktreePathRef = useRef<string | null>(null)

  useEffect(() => {
    setRanges([])
    setDetailsRequest(null)
    if (!mountedEditor || !worktreeId || !enabled) {
      setStatus(null)
      return
    }
    if (dirty) {
      setStatus(translate('editor.gitBlame.status.saveToRefresh', 'Save to refresh blame'))
      return
    }
    const state = useAppStore.getState()
    const worktreePath =
      state.getKnownWorktreeById(worktreeId)?.path ?? inferWorktreePath(filePath, relativePath)
    if (!worktreePath) {
      setStatus(
        translate(
          'editor.gitBlame.status.unavailableWorkspace',
          'Blame unavailable for this workspace'
        )
      )
      return
    }
    const currentGeneration = ++generation.current
    const controller = new AbortController()
    const openFile = state.openFiles.find((file) => file.id === fileId)
    const runtimeContext: RuntimeContext = {
      settings: settingsForRuntimeOwner(state.settings, openFile?.runtimeEnvironmentId),
      worktreeId,
      worktreePath,
      connectionId: getConnectionId(worktreeId) ?? undefined
    }
    runtimeContextRef.current = runtimeContext
    worktreePathRef.current = worktreePath
    setStatus(translate('editor.gitBlame.status.loading', 'Loading blame...'))
    void getRuntimeGitBlame(runtimeContext, relativePath, controller.signal)
      .then((result) => {
        if (generation.current !== currentGeneration) {
          return
        }
        setRanges(result.ranges)
        setStatus(null)
      })
      .catch((error: unknown) => {
        if (generation.current !== currentGeneration) {
          return
        }
        setStatus(getGitBlameErrorMessage(error))
      })
    return () => {
      generation.current += 1
      controller.abort()
    }
  }, [
    contentRevision,
    dirty,
    enabled,
    fileId,
    filePath,
    mountedEditor,
    relativePath,
    repositoryHead,
    worktreeId
  ])

  useEffect(() => {
    if (!mountedEditor || ranges.length === 0 || dirty || !enabled) {
      return
    }
    const decorations = mountedEditor.createDecorationsCollection()
    const renderCurrentLine = (): void => {
      const model = mountedEditor.getModel()
      const lineNumber = mountedEditor.getPosition()?.lineNumber
      const range = lineNumber ? findGitBlameRangeForLine(ranges, lineNumber) : null
      if (!model || !lineNumber || !range || lineNumber > model.getLineCount()) {
        decorations.clear()
        setDetailsRequest(null)
        return
      }
      const endColumn = model.getLineMaxColumn(lineNumber)
      decorations.set([
        {
          range: {
            startLineNumber: lineNumber,
            startColumn: endColumn,
            endLineNumber: lineNumber,
            endColumn
          },
          options: {
            showIfCollapsed: true,
            after: {
              content: `  ${formatGitBlameInlineLabel(range)}`,
              inlineClassName: 'monaco-git-blame-annotation'
            },
            hoverMessage: buildGitBlameHoverMarkdown(range)
          }
        }
      ])
    }
    renderCurrentLine()
    const cursorDisposable = mountedEditor.onDidChangeCursorPosition(() => {
      setDetailsRequest(null)
      renderCurrentLine()
    })
    const handleAnnotationPointerDown = (event: MouseEvent): void => {
      const browserTarget = event.target
      if (
        !(browserTarget instanceof Element) ||
        !browserTarget.closest('.monaco-git-blame-annotation')
      ) {
        return
      }
      const lineNumber = mountedEditor.getPosition()?.lineNumber
      const range = lineNumber ? findGitBlameRangeForLine(ranges, lineNumber) : null
      if (range) {
        const request = { range, anchorX: event.clientX, anchorY: event.clientY }
        window.setTimeout(() => setDetailsRequest(request), 0)
      }
    }
    const domNode = mountedEditor.getDomNode()
    domNode?.addEventListener('mousedown', handleAnnotationPointerDown, true)
    return () => {
      cursorDisposable.dispose()
      domNode?.removeEventListener('mousedown', handleAnnotationPointerDown, true)
      decorations.clear()
    }
  }, [dirty, enabled, mountedEditor, ranges])

  const closeDetails = useCallback(() => setDetailsRequest(null), [])
  const copyHash = useCallback(async (): Promise<void> => {
    if (detailsRequest?.range.commitId) {
      await window.api.ui.writeClipboardText(detailsRequest.range.commitId)
    }
  }, [detailsRequest])
  const openRemoteCommit = useCallback(async (): Promise<void> => {
    const commitId = detailsRequest?.range.commitId
    const runtimeContext = runtimeContextRef.current
    if (!commitId || !runtimeContext) {
      return
    }
    const url = await getRuntimeGitRemoteCommitUrl(runtimeContext, { sha: commitId })
    if (url) {
      await window.api.shell.openUrl(url)
    }
  }, [detailsRequest])
  const openCommitDiff = useCallback(async (): Promise<void> => {
    const commitId = detailsRequest?.range.commitId
    const runtimeContext = runtimeContextRef.current
    const worktreePath = worktreePathRef.current
    if (!commitId || !runtimeContext || !worktreeId || !worktreePath) {
      return
    }
    const compare = await getRuntimeGitCommitCompare(runtimeContext, commitId)
    const entry = compare.entries.find((candidate) => candidate.path === relativePath)
    if (entry) {
      useAppStore.getState().openCommitDiff(
        worktreeId,
        worktreePath,
        entry,
        { ...compare.summary, subject: detailsRequest.range.summary },
        detectLanguage(entry.path)
      )
      setDetailsRequest(null)
    }
  }, [detailsRequest, relativePath, worktreeId])

  return {
    status,
    detailsRequest,
    closeDetails,
    copyHash,
    openRemoteCommit,
    openCommitDiff
  }
}

function inferWorktreePath(filePath: string, relativePath: string): string | null {
  const normalizedFile = filePath.replaceAll('\\', '/')
  const normalizedRelative = relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
  const suffix = `/${normalizedRelative}`
  if (!normalizedRelative || !normalizedFile.toLowerCase().endsWith(suffix.toLowerCase())) {
    return null
  }
  return filePath.slice(0, filePath.length - normalizedRelative.length - 1)
}
