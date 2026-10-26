// In layout-owner builds propose per-workspace rename IDs to main; its frame atomically rekeys drafts/buffers/autosave gate. Refusal changes nothing.

import { isTwinWorkspace, runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import {
  expectContentRekey,
  framesShowTabRekeys,
  type TabRekey
} from '@/runtime/layout-owner-content-rekeys'
import type { EditorFileRename } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../../../types'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { OpenFile } from '../types/open-file'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from '../types/open-file-path-rekey'
import { isEditorTabContentType } from './editor-tab-content-type'
import { restorableEditorFile } from './editor-tab-layout-owner'
import { layoutEditorViewOfOpenFile } from './open-file-layout-view'

/** Main's renames: an edit-mode file's record moves from its old path; a view takes the new one. */
function renamesOf(
  rekeys: readonly OpenFilePathRekey[],
  before: ReadonlyMap<string, OpenFile>,
  after: ReadonlyMap<string, OpenFile>
): EditorFileRename[] {
  return rekeys.map(({ oldFileId, newFileId }) => {
    const old = before.get(oldFileId)
    const renamed = after.get(newFileId)
    const view = renamed && layoutEditorViewOfOpenFile(renamed)
    return {
      fileId: oldFileId,
      newFileId,
      ...(old?.mode === 'edit' && renamed
        ? { record: { fromFilePath: old.filePath, file: restorableEditorFile(renamed) } }
        : {}),
      ...(view ? { view } : {})
    }
  })
}

/** The workspace's editor tabs under their ids after the rename, as main renames them. */
function tabRekeysOf(
  state: AppState,
  worktreeId: string,
  rekeys: readonly OpenFilePathRekey[]
): TabRekey[] {
  const ids = new Map(rekeys.map((rekey) => [rekey.oldFileId, rekey.newFileId]))
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).flatMap((tab) => {
    const newEntityId = ids.get(tab.entityId)
    return isEditorTabContentType(tab.contentType) && newEntityId !== undefined
      ? [
          {
            tabId: tab.id,
            entityId: tab.entityId,
            newTabId: ids.get(tab.id) ?? tab.id,
            newEntityId
          }
        ]
      : []
  })
}

/** Preflight current store, then atomically rename all main-owned workspaces with one durable write per partition. Send twins alone to isolate paired host_not_owned refusal; paired workspaces use direct window rekey. */
export function renameEditorFilesThroughLayoutOwner(
  set: EditorSet,
  get: EditorGet,
  rekeys: readonly OpenFilePathRekey[],
  moveOperationId: string | undefined,
  /** The window's pure rekey (rekey-open-files-action), passed in so neither module imports the other. */
  rekeyOpenFilesPatch: (
    state: AppState,
    rekeys: readonly OpenFilePathRekey[],
    moveOperationId: string | undefined
  ) => { ok: true; patch: Partial<AppState> } | Extract<RekeyOpenFilesResult, { ok: false }>
): RekeyOpenFilesResult {
  const state = get()
  const planned = rekeyOpenFilesPatch(state, rekeys, moveOperationId)
  if (!planned.ok) {
    return planned
  }
  const before = new Map(state.openFiles.map((file) => [file.id, file]))
  const after = new Map((planned.patch.openFiles ?? []).map((file) => [file.id, file]))
  const rekeyHere = (own: readonly OpenFilePathRekey[]) => (s: AppState) => {
    const next = rekeyOpenFilesPatch(s, own, moveOperationId)
    return next.ok ? next.patch : {}
  }
  // Each file's own workspace: the same path can be open in more than one.
  const byWorktree = new Map<string, OpenFilePathRekey[]>()
  for (const rekey of rekeys) {
    const worktreeId = before.get(rekey.oldFileId)?.worktreeId
    if (worktreeId !== undefined) {
      byWorktree.set(worktreeId, [...(byWorktree.get(worktreeId) ?? []), rekey])
    }
  }
  const mains: RenamePart[] = []
  const send = (parts: readonly RenamePart[]) =>
    sendRenames(set, get, state, parts, rekeyHere, (own) => renamesOf(own, before, after))
  for (const [worktreeId, own] of byWorktree) {
    if (runtimeEnvironmentIdUnlessTwin(state, worktreeId)) {
      set(rekeyHere(own)(get()))
    } else if (isTwinWorkspace(state, worktreeId)) {
      // Why alone: main's host_not_owned for a twin would refuse every workspace sent with it.
      send([{ worktreeId, own }])
    } else {
      mains.push({ worktreeId, own })
    }
  }
  if (mains.length > 0) {
    send(mains)
  }
  return { ok: true }
}

type RenamePart = { worktreeId: string; own: OpenFilePathRekey[] }

/** One rename command over `parts`, its content rekey applied by the frame that shows it. */
function sendRenames(
  set: EditorSet,
  get: EditorGet,
  state: AppState,
  [first, ...rest]: readonly RenamePart[],
  rekeyHere: (own: readonly OpenFilePathRekey[]) => (s: AppState) => Partial<AppState>,
  renamesIn: (own: readonly OpenFilePathRekey[]) => EditorFileRename[]
): void {
  if (!first) {
    return
  }
  const parts = [first, ...rest]
  const partRekeys = parts.flatMap((part) => part.own)
  const shown = parts
    .map((part) => ({
      worktreeId: part.worktreeId,
      tabs: tabRekeysOf(state, part.worktreeId, part.own)
    }))
    .filter((part) => part.tabs.length > 0)
  const expected = expectContentRekey(
    // A change no tab shows changes no frame: main's answer rekeys it.
    {
      shows: (cache) =>
        shown.length > 0 &&
        shown.every((part) =>
          framesShowTabRekeys(cache, part.worktreeId, part.worktreeId, part.tabs)
        ),
      patch: rekeyHere(partRekeys)
    },
    partRekeys.flatMap((rekey) => [rekey.oldFileId, rekey.newFileId])
  )
  // Today's rekey is the window's own: it settles as applied, so the disk move stands.
  const today = (): void => expected.applied((patch) => set(patch), get())
  const sent = sendLayoutApply(
    state,
    first.worktreeId,
    {
      type: 'renameEditorFiles',
      renames: renamesIn(first.own),
      ...(rest.length > 0
        ? {
            alsoIn: rest.map((part) => ({
              workspace: part.worktreeId,
              renames: renamesIn(part.own)
            }))
          }
        : {})
    },
    {
      apply: () => expected.applied((patch) => set(patch), get()),
      asToday: today,
      refused: () => expected.dropped()
    }
  )
  if (!sent) {
    today()
  }
}
