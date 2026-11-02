import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { editorModelSiblingTabs, setEditorDiskBaseline } from './editor-save-disk-precondition'
import type { CustomEditorHost } from './plugin-custom-editor-host-types'
import { ORCA_EDITOR_FILE_SAVED_EVENT, type EditorFileSavedDetail } from './editor-autosave'

/**
 * A write to the file on disk while a custom editor tab holds unsaved edits, merged by the editor
 * instead of Orca's banner. Deliberately narrow, the banner on any doubt: one mounted editor view
 * of a local file with no other tab on its buffer, a session that merges, a known ancestor, and an
 * acknowledged merge. Only then is the disk snapshot that merge used stamped as the baseline.
 */

type OutsideMergeState = {
  /** Mounted merging editor views per tab; the merge runs only with exactly one. */
  views: Record<string, number>
  /** A merge in flight per tab: the banner stays hidden until it settles. */
  busy: Record<string, true>
  /** The disk text the tab's unsaved edits started from: recorded while the tab is clean and
   *  after each acknowledged merge, with its signature to match the tab's disk baseline. */
  ancestors: Record<string, { text: string; signature: string }>
}

export const useCustomEditorOutsideMergeStore = create<OutsideMergeState>()(() => ({
  views: {},
  busy: {},
  ancestors: {}
}))

const patch = <K extends keyof OutsideMergeState>(
  key: K,
  fileId: string,
  value: OutsideMergeState[K][string] | undefined
): void =>
  useCustomEditorOutsideMergeStore.setState((state) => {
    const next = { ...state[key] }
    if (value === undefined) {
      delete next[fileId]
    } else {
      next[fileId] = value
    }
    return { [key]: next }
  })

/** A merging editor view of the tab mounted (+1) or went away (-1). */
export function countCustomEditorMergingView(fileId: string, delta: 1 | -1): void {
  const count = (useCustomEditorOutsideMergeStore.getState().views[fileId] ?? 0) + delta
  patch('views', fileId, count > 0 ? count : undefined)
}

export function recordCustomEditorAncestor(fileId: string, text: string): void {
  patch('ancestors', fileId, { text, signature: getDiskBaselineSignature(text) })
}

/** True while the editor is taking a disk change itself, so Orca's banner stays hidden. */
export function useCustomEditorMerging(fileId: string): boolean {
  return useCustomEditorOutsideMergeStore((state) => state.busy[fileId] === true)
}

/** The tab may merge: one merging view, a local file, no other tab sharing its buffer, and an
 *  ancestor that is exactly the disk the tab's baseline names. */
function mergeAncestor(file: OpenFile): string | null {
  const state = useAppStore.getState()
  const merge = useCustomEditorOutsideMergeStore.getState()
  const ancestor = merge.ancestors[file.id]
  const local =
    !file.runtimeEnvironmentId &&
    !file.externalSshTargetId &&
    !getConnectionIdForFile(file.worktreeId, file.filePath)
  const alone = editorModelSiblingTabs(state, file).length === 1
  return merge.views[file.id] === 1 &&
    local &&
    alone &&
    ancestor &&
    file.lastKnownDiskSignature === ancestor.signature
    ? ancestor.text
    : null
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
    access: editorTabFileAccess(state, file)
  })
  return result.isBinary ? null : result.content
}

const liveTab = (fileId: string): OpenFile | undefined =>
  useAppStore.getState().openFiles.find((openFile) => openFile.id === fileId)

/**
 * One merge of the disk as it is now. On acknowledgement, stamps that exact disk snapshot as the
 * baseline and its text as the new ancestor; if the disk moved on meanwhile, marks the tab changed
 * again so the next round merges the newer write. Anything else leaves the conflict for the banner.
 */
export async function mergeOutsideChangeIntoEditor(
  fileId: string,
  host: Pick<CustomEditorHost, 'mergeOutsideChange'>,
  readDisk: (fileId: string) => Promise<string | null> = readDiskText
): Promise<boolean> {
  const file = liveTab(fileId)
  const ancestor = file ? mergeAncestor(file) : null
  if (!file || ancestor === null || file.externalMutation !== 'changed') {
    return false
  }
  patch('busy', fileId, true)
  try {
    const disk = await readDisk(fileId).catch(() => null)
    const merged = disk === null ? null : await host.mergeOutsideChange(disk, ancestor)
    if (disk === null || merged === null || liveTab(fileId)?.externalMutation !== 'changed') {
      return false
    }
    const state = useAppStore.getState()
    setEditorDiskBaseline(state, fileId, getDiskBaselineSignature(disk))
    state.setExternalMutation(fileId, null)
    recordCustomEditorAncestor(fileId, disk)
    // The tab's saved text (what its dirty state compares to) is now this disk text, as after a
    // save; otherwise typing back to the old ancestor would look clean while disk differs.
    window.dispatchEvent(
      new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: { fileId, content: disk, recordViewIds: [fileId] }
      })
    )
    // A write that landed after the snapshot is not merged yet: put the conflict back for it.
    const now = await readDisk(fileId).catch(() => null)
    if (now !== disk) {
      useAppStore.getState().setExternalMutation(fileId, 'changed')
    }
    return true
  } finally {
    patch('busy', fileId, undefined)
  }
}

/** Keeps the ancestor current and runs a merge each time the tab's file changes on disk. */
export function useCustomEditorOutsideMerge(
  fileId: string | undefined,
  host: Pick<CustomEditorHost, 'mergeOutsideChange'>,
  /** The tab's buffer; recorded as the ancestor whenever the tab is clean (disk equals it). */
  content: string
): void {
  const contentRef = useRef(content)
  useLayoutEffect(() => {
    contentRef.current = content
  })
  const clean = useAppStore((state) =>
    fileId === undefined
      ? false
      : state.openFiles.find((openFile) => openFile.id === fileId)?.isDirty === false
  )
  const changed = useAppStore(
    (state) =>
      fileId !== undefined &&
      state.openFiles.find((openFile) => openFile.id === fileId)?.externalMutation === 'changed'
  )
  useEffect(() => {
    if (fileId !== undefined && clean) {
      recordCustomEditorAncestor(fileId, contentRef.current)
    }
  }, [fileId, clean, content])
  useEffect(() => {
    if (fileId !== undefined && changed) {
      void mergeOutsideChangeIntoEditor(fileId, host)
    }
  }, [fileId, changed, host])
}
