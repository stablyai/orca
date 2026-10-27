import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorExternalWatchBatchPathIndex } from '@/components/editor/editor-external-watch-path-index'
import { isExternalReloadableEditorTab } from '@/components/editor/editor-autosave'
import { forgetCombinedDiffViewBodiesForWorktree } from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'
import {
  PATH_EXISTENCE_BATCH_MAX,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  scheduleDebouncedEditorExternalReload,
  scheduleEditorSelfMoveEchoVerification,
  type EditorExternalWatchNotification
} from './editor-external-watch-disk-verification'

// Why: an existence answer is stale once a newer probe or watch event for that tab arrives.
const probeGenerationByFileId = new Map<string, number>()
let probeGenerationSeq = 0

function claimProbeGeneration(fileId: string): number {
  probeGenerationSeq += 1
  probeGenerationByFileId.set(fileId, probeGenerationSeq)
  return probeGenerationSeq
}

export function getPendingOverflowProbeCountForTest(): number {
  return probeGenerationByFileId.size
}

/** Drops pending existence answers for tabs this watch batch touched. */
export function supersedeOverflowProbesForBatch(
  batchPaths: EditorExternalWatchBatchPathIndex,
  openFiles: readonly OpenFile[]
): void {
  if (probeGenerationByFileId.size === 0) {
    return
  }
  const touched = new Set(batchPaths.deletedOpenEditors.map(({ file }) => file.id))
  for (const change of batchPaths.changes) {
    for (const file of batchPaths.matchingOpenFiles(change)) {
      touched.add(file.id)
    }
  }
  for (const file of openFiles) {
    if (probeGenerationByFileId.has(file.id) && batchPaths.matchesCreateOrUpdate(file)) {
      touched.add(file.id)
    }
  }
  // Why: the pending probe's generation can never match again, so its completion no longer owns an entry to delete.
  for (const fileId of touched) {
    probeGenerationByFileId.delete(fileId)
  }
}

type OverflowTarget = Pick<EditorExternalWatchTarget, 'worktreeId' | 'worktreePath'> &
  Partial<
    Pick<
      EditorExternalWatchTarget,
      'connectionId' | 'runtimeEnvironmentId' | 'allowLocalWindowsWslAliases'
    >
  >

type EditTabProbe = {
  fileId: string
  generation: number
  filePath: string
  runtimeEnvironmentId: string | null | undefined
  notification: EditorExternalWatchNotification
}

/** Overflow reloads clean workspace tabs; reconnect resync also probes deletions, while event-storm overflow avoids per-tab probe fan-out. */
export function reconcileEditorTabsAfterOverflow(target: OverflowTarget, resync: boolean): void {
  if (resync) {
    // Invalidate bodies for unmounted combined diffs too, before remount can replay stale cached content.
    forgetCombinedDiffViewBodiesForWorktree(target.worktreeId)
  }
  const state = useAppStore.getState()
  const probes: EditTabProbe[] = []
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file)
    ) {
      continue
    }
    // Why: compare dirty tabs asynchronously; autosave stays free to run its own guarded check.
    if (file.isDirty) {
      if (resync) {
        scheduleEditorSelfMoveEchoVerification(
          {
            ...target,
            connectionId: target.connectionId,
            runtimeEnvironmentId: target.runtimeEnvironmentId ?? null
          },
          [file.id],
          false,
          true
        )
      }
      continue
    }
    const notification: EditorExternalWatchNotification = {
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null,
      ...getLocalWindowsWslAliasOption(target)
    }
    if (file.mode !== 'edit' || !resync) {
      // Why: this reload is newer than any pending resync probe for the tab.
      probeGenerationByFileId.delete(file.id)
      if (file.externalMutation) {
        state.setExternalMutation(file.id, null)
      }
      scheduleDebouncedEditorExternalReload(notification)
      continue
    }
    probes.push({
      fileId: file.id,
      generation: claimProbeGeneration(file.id),
      filePath: file.filePath,
      runtimeEnvironmentId: file.runtimeEnvironmentId,
      notification
    })
  }
  if (probes.length > 0) {
    void reloadEditTabsUnlessGone(target, probes)
  }
}

async function probeEditTabs(
  target: OverflowTarget,
  probes: readonly EditTabProbe[]
): Promise<readonly PathExistenceResult[] | null> {
  const owner = getRuntimeTargetForFileOwner(
    useAppStore.getState(),
    target.worktreeId,
    probes[0].runtimeEnvironmentId
  )
  if (!owner) {
    return null
  }
  const context = {
    target: owner,
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId
  }
  const paths = probes.map((probe) => probe.filePath)
  // Why: the host rejects a batch above its limit outright, which would reload every tab.
  const chunks: string[][] = []
  for (let start = 0; start < paths.length; start += PATH_EXISTENCE_BATCH_MAX) {
    chunks.push(paths.slice(start, start + PATH_EXISTENCE_BATCH_MAX))
  }
  try {
    const results = await Promise.all(
      chunks.map((chunk) =>
        // Why: a whole-request "not found" (worktree re-pairing) must never mark every tab deleted.
        runtimePathsExist(context, chunk, undefined, { codedAbsenceOnly: true })
      )
    )
    return results.flat()
  } catch {
    // Why: a failed probe cannot prove absence; reload as before.
    return null
  }
}

// Mark confirmed deletions instead of replacing last-known content with read errors.
async function reloadEditTabsUnlessGone(
  target: OverflowTarget,
  probes: readonly EditTabProbe[]
): Promise<void> {
  const results = await probeEditTabs(target, probes)
  const state = useAppStore.getState()
  probes.forEach((probe, index) => {
    if (probeGenerationByFileId.get(probe.fileId) !== probe.generation) {
      return
    }
    probeGenerationByFileId.delete(probe.fileId)
    const live = state.openFiles.find((file) => file.id === probe.fileId)
    if (!live || live.isDirty || live.mode !== 'edit') {
      return
    }
    const row = results?.[index]
    if (row && 'exists' in row && !row.exists) {
      // Why: keep a rename mark; without watch events a rename and a delete look the same.
      if (live.externalMutation !== 'deleted' && live.externalMutation !== 'renamed') {
        state.setExternalMutation(live.id, 'deleted')
      }
      return
    }
    if (live.externalMutation) {
      state.setExternalMutation(live.id, null)
    }
    scheduleDebouncedEditorExternalReload(probe.notification)
  })
}
