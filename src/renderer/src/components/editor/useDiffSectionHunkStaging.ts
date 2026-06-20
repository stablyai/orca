import { useCallback, useState } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { toast } from 'sonner'
import { buildHunkPatch } from '../../../../shared/git-hunk-patch'
import { applyRuntimeGitIndexPatch, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { DiffSection } from './diff-section-types'
import { useDiffHunkStageDecorator } from './useDiffHunkStageDecorator'
import { useDiffSectionHunks } from './useDiffSectionHunks'

export type DiffSectionHunkStaging = {
  worktreePath: string
  connectionId?: string
  settings: RuntimeGitContext['settings']
  /** Refresh git status after an apply so the staged/unstaged split updates. */
  onApplied: () => void
}

// Wires per-hunk staging onto a working-tree diff section; inert for binary,
// read-only, errored, or dirty sections that can't safely round-trip a patch.
export function useDiffSectionHunkStaging({
  section,
  worktreeId,
  modifiedEditor,
  hunkStaging
}: {
  section: DiffSection
  worktreeId?: string
  modifiedEditor: monacoEditor.ICodeEditor | null
  hunkStaging?: DiffSectionHunkStaging
}): void {
  const isStagedArea = section.area === 'staged'
  const active =
    Boolean(hunkStaging) &&
    (section.area === 'unstaged' || section.area === 'staged') &&
    !section.dirty &&
    !section.error &&
    section.diffResult?.kind === 'text'
  const [applyingHunk, setApplyingHunk] = useState(false)
  const parsedHunkDiff = useDiffSectionHunks({
    enabled: active,
    worktreeId,
    worktreePath: hunkStaging?.worktreePath ?? '',
    connectionId: hunkStaging?.connectionId,
    settings: hunkStaging?.settings,
    filePath: section.path,
    staged: isStagedArea,
    contentGeneration: section.contentGeneration
  })
  const handleApplyHunk = useCallback(
    async (hunkIndex: number): Promise<void> => {
      if (!hunkStaging) {
        return
      }
      const patch = buildHunkPatch(parsedHunkDiff, [hunkIndex])
      if (!patch) {
        return
      }
      setApplyingHunk(true)
      try {
        await applyRuntimeGitIndexPatch(
          {
            settings: hunkStaging.settings,
            worktreeId,
            worktreePath: hunkStaging.worktreePath,
            connectionId: hunkStaging.connectionId
          },
          { filePath: section.path, patch, reverse: isStagedArea }
        )
      } catch (error) {
        toast.error(isStagedArea ? 'Failed to unstage hunk' : 'Failed to stage hunk', {
          description: error instanceof Error ? error.message : undefined
        })
      } finally {
        setApplyingHunk(false)
        // Why: refresh on success and failure — a failed apply usually means the
        // diff moved under us, so re-fetching realigns the remaining hunks.
        hunkStaging.onApplied()
      }
    },
    [hunkStaging, parsedHunkDiff, worktreeId, section.path, isStagedArea]
  )
  useDiffHunkStageDecorator({
    editor: active ? modifiedEditor : null,
    hunks: parsedHunkDiff.hunks,
    label: isStagedArea ? 'Unstage hunk' : 'Stage hunk',
    disabled: applyingHunk,
    onApplyHunk: handleApplyHunk
  })
}
