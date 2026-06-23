import { useEffect, useState } from 'react'
import { getRuntimeGitFileDiffPatch, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { parseFileDiff, type ParsedFileDiff } from '../../../../shared/git-hunk-patch'

const EMPTY: ParsedFileDiff = { headerLines: [], hunks: [], isBinary: false }

/** Fetches the per-file unified diff and parses its hunks; refetches on
 * contentGeneration so anchors track the live file. git is the source of truth. */
export function useDiffSectionHunks(args: {
  enabled: boolean
  worktreeId?: string
  worktreePath: string
  connectionId?: string
  settings: RuntimeGitContext['settings']
  filePath: string
  staged: boolean
  contentGeneration?: number
}): ParsedFileDiff {
  const {
    enabled,
    worktreeId,
    worktreePath,
    connectionId,
    settings,
    filePath,
    staged,
    contentGeneration
  } = args
  const [parsed, setParsed] = useState<ParsedFileDiff>(EMPTY)

  useEffect(() => {
    if (!enabled) {
      setParsed(EMPTY)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const patch = await getRuntimeGitFileDiffPatch(
          { settings, worktreeId, worktreePath, connectionId },
          { filePath, staged }
        )
        if (!cancelled) {
          setParsed(parseFileDiff(patch))
        }
      } catch {
        // Why: failure (e.g. an older relay without git.diffPatch) just hides the
        // per-hunk controls; file-level staging in Source Control still works.
        if (!cancelled) {
          setParsed(EMPTY)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    enabled,
    worktreeId,
    worktreePath,
    connectionId,
    settings,
    filePath,
    staged,
    contentGeneration
  ])

  return parsed
}
