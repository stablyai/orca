import { useEffect, useState } from 'react'
import type { editor } from 'monaco-editor'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import { isGitRepoKind } from '../../../../../shared/repo-kind'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import {
  buildGitChangeGutterDecorations,
  type GitChangeOverviewRulerColors
} from './git-change-gutter-decorations'
import { computeGitChangeHunks } from './git-change-hunks'
import {
  getGitHeadBaselineKey,
  loadGitHeadBaseline,
  peekGitHeadBaseline,
  toGitHeadBaseline,
  type GitHeadBaseline
} from './git-head-baseline-cache'

const REPAINT_DEBOUNCE_MS = 150
// Why: a trailing debounce alone never fires while an agent streams edits into the file.
const REPAINT_MAX_WAIT_MS = 500
const MAX_GUTTER_LINES = 20_000

function readOverviewRulerColors(): GitChangeOverviewRulerColors {
  const styles = getComputedStyle(document.documentElement)
  return {
    added: styles.getPropertyValue('--git-decoration-added').trim(),
    modified: styles.getPropertyValue('--git-decoration-modified').trim(),
    deleted: styles.getPropertyValue('--git-decoration-deleted').trim()
  }
}

async function readGitHeadBaseline(fileId: string): Promise<GitHeadBaseline> {
  const state = useAppStore.getState()
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return null
  }
  const worktreePath = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
  const { connectionId, target } = getEditorFileReadContext(state, file, worktreePath)
  const result = await getRuntimeGitDiff(
    { target, worktreeId: file.worktreeId, worktreePath, connectionId },
    { filePath: file.relativePath, staged: false, compareAgainstHead: true }
  )
  return toGitHeadBaseline(result)
}

/** Marks buffer lines that differ from HEAD. Disabled, it reads no Git and computes no diffs. */
export function useMonacoGitChangeGutter(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  fileId: string
  worktreeId: string | undefined
  relativePath: string
  eligible: boolean
}): void {
  const { mountedEditor, fileId, worktreeId, relativePath, eligible } = params
  const baselineKey = useAppStore((state) => {
    if (!eligible || !worktreeId || state.settings?.editorGitChangeGutterEnabled !== true) {
      return null
    }
    const worktree = selectKnownWorktreeById(state, worktreeId)
    const repo = worktree ? getIndexedRepoMap(state.repos).get(worktree.repoId) : undefined
    if (!repo || !isGitRepoKind(repo)) {
      return null
    }
    return getGitHeadBaselineKey({
      worktreeId,
      relativePath,
      head: state.gitStatusHeadByWorktree[worktreeId],
      statusEntries: state.gitStatusByWorktree[worktreeId]
    })
  })
  const [baseline, setBaseline] = useState<GitHeadBaseline>(null)
  // Repaint on theme change: the overview ruler holds resolved colors.
  const isDarkTheme = useDocumentDarkTheme()

  useEffect(() => {
    if (baselineKey === null) {
      setBaseline(null)
      return
    }
    const cached = peekGitHeadBaseline(baselineKey)
    if (cached !== undefined) {
      setBaseline(cached)
      return
    }
    let superseded = false
    // Why: the previous baseline stays painted until the new one lands, so marks do not blink over SSH.
    loadGitHeadBaseline(baselineKey, () => readGitHeadBaseline(fileId)).then(
      (loaded) => {
        if (!superseded) {
          setBaseline(loaded)
        }
      },
      () => {
        // Why: the gutter is ambient; an unreadable baseline drops the marks without an error surface.
        if (!superseded) {
          setBaseline(null)
        }
      }
    )
    return () => {
      superseded = true
    }
  }, [baselineKey, fileId])

  useEffect(() => {
    const model = mountedEditor?.getModel()
    if (!mountedEditor || !model || !baseline) {
      return
    }
    const collection = mountedEditor.createDecorationsCollection()
    const overviewRulerColors = readOverviewRulerColors()
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastPaintAt = 0
    const paint = (): void => {
      timer = null
      lastPaintAt = Date.now()
      const hunks =
        model.getLineCount() > MAX_GUTTER_LINES || baseline.length > MAX_GUTTER_LINES
          ? null
          : computeGitChangeHunks(baseline, model.getLinesContent())
      collection.set(hunks ? buildGitChangeGutterDecorations(hunks, overviewRulerColors) : [])
    }
    paint()
    const contentSub = model.onDidChangeContent(() => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      const untilMaxWait = REPAINT_MAX_WAIT_MS - (Date.now() - lastPaintAt)
      timer = setTimeout(paint, Math.max(0, Math.min(REPAINT_DEBOUNCE_MS, untilMaxWait)))
    })
    return () => {
      contentSub.dispose()
      if (timer !== null) {
        clearTimeout(timer)
      }
      collection.clear()
    }
  }, [mountedEditor, baseline, isDarkTheme])
}
