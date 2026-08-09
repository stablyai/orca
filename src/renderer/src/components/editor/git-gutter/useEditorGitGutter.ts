import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { isGitRepoKind } from '../../../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree-id'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getRuntimeGitDiff } from '@/runtime/runtime-git-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { useRepoMap, useWorktreeById } from '@/store/selectors'
import { buildGitGutterDecorations } from './git-gutter-decorations'
import { computeGitGutterHunks, splitGitGutterLines } from './git-gutter-line-diff'
import { computeGitGutterBaselineToken, isGitGutterEligible } from './git-gutter-refresh-rules'

// Why: a keystroke must not schedule a git read; one diff after the user pauses is enough.
export const GIT_GUTTER_DEBOUNCE_MS = 200
// Why: `content` changes on every keystroke, so a pure trailing debounce never fires while edits
// keep arriving — a typist above ~6 chars/s, or an agent streaming a file, freezes the gutter for
// the whole burst. Cap the wait since the last paint so the marks keep moving.
export const GIT_GUTTER_MAX_WAIT_MS = 500

type UseEditorGitGutterArgs = {
  editorInstance: editor.IStandaloneCodeEditor | null
  fileId: string
  content: string
}

/**
 * Worktree root for a file. Prefer the store's own worktree path; the length slice is only a
 * fallback for worktrees the store has not indexed. It is separator-agnostic because it counts
 * characters rather than splitting, and it yields '' — no gutter — for a file that is not under
 * the worktree at all (external SSH paths, where relativePath is the absolute path).
 */
function resolveWorktreeRoot(
  worktreePath: string | undefined,
  filePath: string,
  relativePath: string
): string {
  if (worktreePath) {
    return worktreePath
  }
  const rootLength = filePath.length - relativePath.length - 1
  if (!relativePath || rootLength <= 0 || !filePath.endsWith(relativePath)) {
    return ''
  }
  return filePath.slice(0, rootLength)
}

export function useEditorGitGutter({
  editorInstance,
  fileId,
  content
}: UseEditorGitGutterArgs): void {
  const gutterSettingEnabled = useAppStore((state) => state.settings?.editorGitGutter !== false)
  const file = useAppStore((state) => state.openFiles.find((candidate) => candidate.id === fileId))
  const worktreeId = file?.worktreeId ?? ''
  const relativePath = file?.relativePath ?? ''
  const filePath = file?.filePath ?? ''
  const runtimeEnvironmentId = file?.runtimeEnvironmentId ?? undefined
  const statusEntries = useAppStore((state) =>
    worktreeId ? state.gitStatusByWorktree[worktreeId] : undefined
  )
  const headSha = useAppStore((state) =>
    worktreeId ? state.gitStatusHeadByWorktree[worktreeId] : undefined
  )

  // Why: resolve the repo of the FILE's worktree, not the active one — a background tab may sit in
  // a different workspace. An empty status array does not imply a git repo (git/status.ts returns
  // `{ entries: [] }` for a plain directory), so the repo kind is the only safe gate; guessing
  // would cost a doomed git round trip per open and per debounce tick over SSH. The plain repo map
  // is deliberate: useRepoById is scoped to the active workspace's execution host and returns null
  // on a mismatch, which would disable the gutter for a reason irrelevant to `kind`.
  const worktree = useWorktreeById(worktreeId || null)
  const repoMap = useRepoMap()
  const repoId = worktree?.repoId ?? (worktreeId ? getRepoIdFromWorktreeId(worktreeId) : null)
  const repo = repoId ? repoMap.get(repoId) : undefined
  const worktreeRoot = resolveWorktreeRoot(worktree?.path, filePath, relativePath)

  const eligible =
    !!file &&
    !!worktreeRoot &&
    isGitGutterEligible({
      enabled: gutterSettingEnabled,
      mode: file.mode,
      relativePath,
      statusEntries,
      isGitBackedWorktree: !!repo && isGitRepoKind(repo)
    })

  const baselineToken = useMemo(
    () => computeGitGutterBaselineToken({ worktreeId, relativePath, headSha, statusEntries }),
    [headSha, relativePath, statusEntries, worktreeId]
  )

  const [baseline, setBaseline] = useState<string | null>(null)
  const collectionRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const generationRef = useRef(0)
  const lastPaintAtRef = useRef(0)
  const paintedBaselineRef = useRef<readonly string[] | null>(null)

  // Why: MonacoEditor is keyed by path, not tab id, so one hook instance can outlive the file it
  // was mounted for — a retained baseline would diff the next file against the wrong HEAD blob.
  useEffect(() => {
    setBaseline(null)
    collectionRef.current?.clear()
  }, [eligible, fileId, relativePath, worktreeId])

  // Why: only baseline identity is in the deps, so typing never reaches this effect.
  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    if (eligible) {
      const context = {
        // Why: both reads are deliberately non-reactive and stay out of the deps. They pick the
        // host that owns this file, which only changes with the identity already in the deps;
        // subscribing would refetch the blob on every unrelated settings or connection write.
        settings: settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId),
        worktreeId,
        worktreePath: worktreeRoot,
        connectionId: getConnectionIdForFile(worktreeId, filePath) ?? undefined
      }
      void getRuntimeGitDiff(context, {
        filePath: relativePath,
        staged: false,
        compareAgainstHead: true
      })
        .then((result) => {
          if (generationRef.current !== generation) {
            return
          }
          // Why: binary blobs AND over-limit diffs both come back with empty content. Accepting ''
          // as a baseline would diff the whole file against nothing and paint it all green. Test
          // `limited !== true`, not presence: the field has a legitimate `{ limited: false }`
          // variant, and a host on a newer Orca may start attaching it across the RPC wire.
          setBaseline(
            result.kind === 'text' && result.largeDiffRenderLimit?.limited !== true
              ? result.originalContent
              : null
          )
        })
        .catch(() => {
          // Why: the gutter is ambient. A disconnected SSH host drops the marks, never toasts.
          if (generationRef.current === generation) {
            setBaseline(null)
          }
        })
    }
    // Why: a late reply from a superseded request must not overwrite a newer baseline.
    return () => {
      generationRef.current += 1
    }
  }, [
    baselineToken,
    eligible,
    filePath,
    relativePath,
    runtimeEnvironmentId,
    worktreeId,
    worktreeRoot
  ])

  // Why: paints are frequent and the baseline changes rarely, so split it once per baseline.
  const baselineLines = useMemo(
    () => (baseline === null ? null : splitGitGutterLines(baseline)),
    [baseline]
  )

  // Why: a collection is bound to the editor that created it, and set() silently no-ops once that
  // editor is disposed (codeEditorWidget returns null with no throw), so never carry one across a
  // swap — MonacoEditor nulls its own refs in onDidDispose for the same reason.
  useEffect(() => {
    collectionRef.current?.clear()
    collectionRef.current = null
  }, [editorInstance])

  // Repaint from the cached baseline. This is the only path typing takes.
  useEffect(() => {
    if (!editorInstance) {
      return
    }
    // Why: a null baseline while the FIRST one loads must render nothing, but it must not clear —
    // during a refetch the previous baseline is still held, so the marks never blink empty.
    if (baselineLines === null) {
      collectionRef.current?.clear()
      return
    }
    // Why: a fresh baseline paints on the leading edge so the marks land with it, not 200ms later.
    const sincePaint = Date.now() - lastPaintAtRef.current
    const delay =
      paintedBaselineRef.current === baselineLines
        ? Math.min(GIT_GUTTER_DEBOUNCE_MS, Math.max(0, GIT_GUTTER_MAX_WAIT_MS - sincePaint))
        : 0
    const timer = setTimeout(() => {
      const decorations = buildGitGutterDecorations(
        computeGitGutterHunks(baselineLines, splitGitGutterLines(content))
      )
      // Why: create empty and always paint through set(), so first and later paints share a path.
      collectionRef.current ??= editorInstance.createDecorationsCollection([])
      collectionRef.current.set(decorations)
      lastPaintAtRef.current = Date.now()
      paintedBaselineRef.current = baselineLines
    }, delay)
    return () => {
      clearTimeout(timer)
    }
  }, [baselineLines, content, editorInstance])

  useEffect(
    () => () => {
      collectionRef.current?.clear()
      collectionRef.current = null
    },
    []
  )
}
