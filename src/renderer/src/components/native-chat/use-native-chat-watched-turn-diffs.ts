import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/runtime/files/watching/worktree-file-change-event'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import type { FsChangeEvent } from '../../../../shared/file-watch/filesystem-change-event'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import {
  MAX_WATCHED_DIFF_FILES_PER_TURN,
  watchedFilePathsFromFsPayload,
  watchedEditFileFromGitDiff,
  watchedTurnDiffWithFile,
  type WatchedTurnDiff
} from './native-chat-watched-turn-diffs'

type TurnBuffer = {
  /** Insertion-ordered touched paths; first-seen event kind wins. */
  touched: Map<string, FsChangeEvent['kind']>
  /** Watcher dropped events for this turn: re-diff everything on settle. */
  overflow: boolean
  /** Settle resolution launched; guards the every-render settle pass. */
  settleRequested: boolean
  /** Settled, resolved diffs; also feeds the live view. */
  diff: WatchedTurnDiff | undefined
}

function emptyBuffer(): TurnBuffer {
  return { touched: new Map(), overflow: false, settleRequested: false, diff: undefined }
}

const NO_WATCHED_DIFFS: ReadonlyMap<string, WatchedTurnDiff> = new Map()

/** Attribute workspace file-watcher events to chat turns so agent file edits
 *  surface as per-turn diff rollups even when the host never reports a tool
 *  edit (e.g. Claude Code's own writes that arrive only as journal text). The
 *  watcher buffer collects paths during the turn; when the turn settles, one
 *  `git.diff` per touched path resolves the card content. */
export function useNativeChatWatchedTurnDiffs({
  runtimeContext,
  liveTurnKey,
  settledTurns,
  isWorking,
  isVisible
}: {
  runtimeContext: RuntimeFileOperationArgs | null | undefined
  liveTurnKey: string | undefined
  /** Host-settled turns; a turn's watcher buffer resolves once it lands here. */
  settledTurns: ReadonlyMap<string, unknown> | undefined
  isWorking: boolean
  isVisible: boolean
}): ReadonlyMap<string, WatchedTurnDiff> {
  const worktreePath = runtimeContext?.worktreePath ?? null
  const worktreeId = runtimeContext?.worktreeId ?? null
  const connectionId = runtimeContext?.connectionId ?? null
  const target = runtimeContext?.target ?? null
  const normalizedWorktreePath = worktreePath
    ? normalizeRuntimePathForComparison(worktreePath)
    : null
  const runtimeEnvironmentId =
    runtimeContext?.target?.kind === 'environment' ? runtimeContext.target.environmentId : null

  const enabled =
    isVisible && worktreePath !== null && normalizedWorktreePath !== null && target !== null

  // Buffers persist across renders; liveTurnKey/index changes only re-slice them.
  const buffersRef = useRef<Map<string, TurnBuffer>>(new Map())
  /** Path list of the live turn, bumped on every watcher event so the UI can
   *  show "editing foo.ts" before settle. */
  const [liveTouched, setLiveTouched] = useState<readonly string[]>([])
  /** Resolved diffs keyed by turn; only state that re-renders the list. */
  const [settledDiffs, setSettledDiffs] =
    useState<ReadonlyMap<string, WatchedTurnDiff>>(NO_WATCHED_DIFFS)
  /** Latest resolved diff for the still-running turn (best effort, may update). */
  const [liveDiff, setLiveDiff] = useState<WatchedTurnDiff | undefined>(undefined)

  const gitContext = useMemo<RuntimeGitContext | null>(() => {
    if (!target || !worktreePath) {
      return null
    }
    return { target, worktreeId, worktreePath, connectionId: connectionId ?? undefined }
  }, [target, worktreeId, worktreePath, connectionId])

  // Resolve a turn's touched paths into git diffs. Runs serially; newer
  // resolutions for the same turn supersede older ones via `generation`.
  const generationRef = useRef(0)
  const settleTurn = (turnKey: string, buffer: TurnBuffer): void => {
    const context = gitContext
    if (!context) {
      return
    }
    buffer.settleRequested = true
    const generation = ++generationRef.current
    const paths = Array.from(buffer.touched.entries()).slice(0, MAX_WATCHED_DIFF_FILES_PER_TURN)
    void (async () => {
      let diff = buffer.diff
      for (const [path, kind] of paths) {
        try {
          const result = await getRuntimeGitDiff(context, {
            filePath: path,
            staged: false,
            compareAgainstHead: true
          })
          const file = watchedEditFileFromGitDiff(path, result, kind)
          if (file && (file.added > 0 || file.removed > 0)) {
            diff = watchedTurnDiffWithFile(diff, file)
          }
        } catch {
          // A vanished file or failed read is not a transcript error; skip it.
        }
        if (generation !== generationRef.current) {
          return
        }
      }
      buffer.diff = diff
      setSettledDiffs((current) => {
        const next = new Map(current)
        if (diff && diff.files.length > 0) {
          next.set(turnKey, diff)
        } else {
          next.delete(turnKey)
        }
        return next
      })
    })()
  }

  // Watch filesystem events for this worktree and bucket them into the live turn.
  useEffect(() => {
    if (!enabled || !worktreePath || !normalizedWorktreePath) {
      return
    }
    const handle = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeFileChangeEventDetail>).detail
      if (!detail) {
        return
      }
      if ((detail.runtimeEnvironmentId ?? null) !== runtimeEnvironmentId) {
        return
      }
      const { payload } = detail
      if (normalizeRuntimePathForComparison(payload.worktreePath) !== normalizedWorktreePath) {
        return
      }
      const turnKey = liveTurnKey
      if (!turnKey) {
        return
      }
      const buffers = buffersRef.current
      let buffer = buffers.get(turnKey)
      if (!buffer) {
        buffer = emptyBuffer()
        buffers.set(turnKey, buffer)
      }
      const { paths, overflow } = watchedFilePathsFromFsPayload(payload, worktreePath)
      if (!buffer.overflow) {
        buffer.overflow = overflow
      }
      for (const path of paths) {
        if (!buffer.touched.has(path)) {
          buffer.touched.set(path, eventKindForPath(payload, path))
        }
      }
      setLiveTouched(Array.from(buffer.touched.keys()))
    }
    const eventKindForPath = (
      payload: WorktreeFileChangeEventDetail['payload'],
      path: string
    ): FsChangeEvent['kind'] => {
      for (const event of payload.events) {
        if (event.isDirectory === true) {
          continue
        }
        for (const absolutePath of [event.absolutePath, event.oldAbsolutePath]) {
          if (!absolutePath) {
            continue
          }
          if (absolutePath.endsWith(path) || absolutePath.endsWith(path.replace(/\//g, '\\'))) {
            return event.kind
          }
        }
      }
      return 'update'
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handle)
    return () => window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handle)
  }, [enabled, worktreePath, normalizedWorktreePath, runtimeEnvironmentId, liveTurnKey])

  const isWorkingRef = useRef(isWorking)
  useLayoutEffect(() => {
    isWorkingRef.current = isWorking
  })

  // Settle turns whose host timing landed, and refresh the live turn's diff on
  // a slow cadence while it runs (the agent may still be writing).
  useEffect(() => {
    const buffers = buffersRef.current
    for (const [turnKey, settled] of settledTurns ?? []) {
      if (settled === null || turnKey === liveTurnKey) {
        continue
      }
      const buffer = buffers.get(turnKey)
      if (buffer && buffer.touched.size > 0 && !buffer.settleRequested) {
        settleTurn(turnKey, buffer)
      }
    }
  })

  // The live turn's own diff: re-resolve touched paths periodically so the
  // rollup tracks writes while the agent still works. Cheap: git.diff is cached
  // by the settled-diff cache and only re-runs on stamp change.
  useEffect(() => {
    if (!enabled || !liveTurnKey) {
      setLiveTouched([])
      setLiveDiff(undefined)
      return
    }
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const context = gitContext
      const buffer = buffersRef.current.get(liveTurnKey)
      if (!context || !buffer || buffer.touched.size === 0) {
        return
      }
      let diff: WatchedTurnDiff | undefined
      for (const [path, kind] of Array.from(buffer.touched.entries()).slice(
        0,
        MAX_WATCHED_DIFF_FILES_PER_TURN
      )) {
        try {
          const result = await getRuntimeGitDiff(context, {
            filePath: path,
            staged: false,
            compareAgainstHead: true
          })
          const file = watchedEditFileFromGitDiff(path, result, kind)
          if (file && (file.added > 0 || file.removed > 0)) {
            diff = watchedTurnDiffWithFile(diff, file)
          }
        } catch {
          // transient read failure; next tick retries
        }
      }
      if (!cancelled) {
        setLiveDiff(diff)
      }
    }
    void refresh()
    const stopPoll = installWindowVisibilityInterval({
      run: () => {
        if (buffersRef.current.get(liveTurnKey)?.touched.size) {
          void refresh()
        }
      },
      intervalMs: 2_000
    })
    return () => {
      cancelled = true
      stopPoll()
    }
  }, [enabled, liveTurnKey, gitContext, liveTouched])

  return useMemo(() => {
    if (!liveTurnKey || !liveDiff || liveDiff.files.length === 0) {
      return settledDiffs
    }
    const next = new Map(settledDiffs)
    next.set(liveTurnKey, liveDiff)
    return next
  }, [settledDiffs, liveTurnKey, liveDiff])
}
