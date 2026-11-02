import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { useAppStore } from '@/store'
import { keepTabEditsOverExternalChange } from './ExternalFileChangeBanner'
import type { CustomEditorHost } from './plugin-custom-editor-host-types'

/**
 * Tabs whose live custom editor merges outside changes (its document session has `merge`). For
 * them a disk write under unsaved edits goes to the editor to merge, and Orca shows no banner.
 */
export const useCustomEditorOutsideMergeStore = create<{ merging: Record<string, true> }>()(() => ({
  merging: {}
}))

export function setCustomEditorMerging(fileId: string, merging: boolean): void {
  useCustomEditorOutsideMergeStore.setState(({ merging: current }) => {
    if (Boolean(current[fileId]) === merging) {
      return { merging: current }
    }
    const next = { ...current }
    if (merging) {
      next[fileId] = true
    } else {
      delete next[fileId]
    }
    return { merging: next }
  })
}

export function useCustomEditorMerges(fileId: string): boolean {
  return useCustomEditorOutsideMergeStore((state) => state.merging[fileId] === true)
}

/** Reads the file as it is on disk now; null when it cannot be read as text. */
async function readDiskText(fileId: string): Promise<string | null> {
  const state = useAppStore.getState()
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  const target = file
    ? getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
    : null
  if (!file || !target) {
    return null
  }
  const result = await readRuntimeFileContent({
    target,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file),
    terminalArtifactGrantId: file.terminalArtifactGrantId
  })
  return result.isBinary ? null : result.content
}

/**
 * A disk write under the tab's unsaved edits: send the new disk text, with the text those edits
 * started from, to an editor that merges, then keep the tab's (now merged) edits as Orca's
 * "Keep My Edits" does. Anything else falls back to the banner.
 */
export async function mergeOutsideChangeIntoEditor(
  fileId: string,
  host: Pick<CustomEditorHost, 'mergeOutsideChange'>,
  /** The disk text the tab's unsaved edits started from (the content it loaded). */
  ancestor: string,
  readDisk: (fileId: string) => Promise<string | null> = readDiskText
): Promise<boolean> {
  const disk = await readDisk(fileId).catch(() => null)
  const file = useAppStore.getState().openFiles.find((openFile) => openFile.id === fileId)
  if (disk === null || file?.externalMutation !== 'changed') {
    return false
  }
  if (!host.mergeOutsideChange(disk, ancestor)) {
    setCustomEditorMerging(fileId, false)
    return false
  }
  keepTabEditsOverExternalChange(file)
  return true
}

/** Runs the merge each time the tab's file changes on disk under unsaved edits. */
export function useCustomEditorOutsideMerge(
  fileId: string | undefined,
  host: Pick<CustomEditorHost, 'mergeOutsideChange'>,
  ancestor: string | undefined
): void {
  const merges = useCustomEditorMerges(fileId ?? '')
  const changed = useAppStore(
    (state) =>
      fileId !== undefined &&
      state.openFiles.find((openFile) => openFile.id === fileId)?.externalMutation === 'changed'
  )
  // The ancestor is read when a change lands; a later load must not rerun the merge.
  const ancestorRef = useRef(ancestor)
  useLayoutEffect(() => {
    ancestorRef.current = ancestor
  })
  useEffect(() => {
    const base = ancestorRef.current
    if (fileId !== undefined && base !== undefined && merges && changed) {
      void mergeOutsideChangeIntoEditor(fileId, host, base).then((merged) => {
        if (!merged) {
          setCustomEditorMerging(fileId, false)
        }
      })
    }
  }, [fileId, merges, changed, host])
}
