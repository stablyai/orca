// Restore reownership proposes IDs to main (same-workspace reownership is rename); move frames atomically rekey content (F42).

import type { Tab } from '../../../../../../shared/tab-types'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import {
  expectContentRekey,
  framesShowTabRekeys,
  type TabRekey
} from '@/runtime/layout-owner-content-rekeys'
import type { AppState } from '../../../types'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { OpenFile } from '../types/open-file'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from '../types/restored-editor-owner'
import { resolveRestoredEditorOwnerDestination } from '../actions/restored-editor-owner-destination'
import {
  buildRestoredEditorOwnerTransition,
  restoredEditorTargetGroupId
} from '../actions/restored-editor-owner-transition'
import { restorableEditorFile } from './editor-tab-layout-owner'
import { layoutEditorViewOfOpenFile } from './open-file-layout-view'

type TabMove = { tab: Tab; newTabId: string; newEntityId: string }

/** Fold moved files into tabs already shown in target groups, including earlier moved tabs, matching main’s destination IDs. */
function tabRekeysOf(
  state: AppState,
  to: string,
  groupId: string,
  moves: readonly TabMove[]
): TabRekey[] {
  const tabs = new Map((state.unifiedTabsByWorktree[to] ?? []).map((tab) => [tab.id, tab]))
  const shown = new Map<string, string>()
  for (const id of state.groupsByWorktree[to]?.find((group) => group.id === groupId)?.tabOrder ??
    []) {
    const tab = tabs.get(id)
    if (tab) {
      shown.set(`${tab.contentType}\0${tab.entityId}`, tab.id)
    }
  }
  return moves.map(({ tab, newTabId, newEntityId }) => {
    const key = `${tab.contentType}\0${newEntityId}`
    const landed = shown.get(key) ?? newTabId
    shown.set(key, landed)
    return { tabId: tab.id, entityId: tab.entityId, newTabId: landed, newEntityId }
  })
}

function moveCommand(
  args: RestoredEditorOwnerMigration,
  source: OpenFile,
  moves: readonly TabMove[],
  groupId: string,
  renamedFile: (id: string) => OpenFile | undefined,
  newFileId: string
): WindowLayoutCommand {
  const viewOf = (id: string) => {
    const file = renamedFile(id)
    const view = file && layoutEditorViewOfOpenFile(file)
    return view ? { view } : {}
  }
  // Main keeps only edit-mode files' records.
  const moved = renamedFile(newFileId)
  const record = source.mode === 'edit' && moved ? restorableEditorFile(moved) : undefined
  if (source.worktreeId === args.targetWorktreeId) {
    const renames = new Map(moves.map((move) => [move.tab.entityId, move.newEntityId]))
    return {
      type: 'renameEditorFiles',
      renames: [...renames].map(([fileId, renamedId]) => ({
        fileId,
        newFileId: renamedId,
        ...(fileId === source.id && record
          ? { record: { fromFilePath: source.filePath, file: record } }
          : {}),
        ...viewOf(renamedId)
      }))
    }
  }
  return {
    type: 'moveTabToWorkspace',
    toWorkspace: args.targetWorktreeId,
    tabs: moves.map(({ tab, newTabId, newEntityId }) => ({
      tabId: tab.id,
      newTabId,
      newEntityId,
      ...viewOf(newEntityId)
    })),
    groupId,
    ...(record ? { file: record } : {})
  }
}

/** Send move and promise its result; return null when impossible/tabless/paired-owned for direct caller fallback. today handles twins main routes paired. */
export function reparentRestoredEditorThroughLayoutOwner(
  set: EditorSet,
  get: EditorGet,
  args: RestoredEditorOwnerMigration,
  activatesTarget: boolean,
  today: () => void
): RestoredEditorOwnerResult | null {
  const state = get()
  const destination = resolveRestoredEditorOwnerDestination(state, args)
  const to = args.targetWorktreeId
  if (!destination.ok || runtimeEnvironmentIdUnlessTwin(state, to)) {
    return null
  }
  const { source, newFileId, previewIdMigrations } = destination
  const from = source.worktreeId
  const migrations = new Map([[source.id, newFileId], ...previewIdMigrations])
  const moves: TabMove[] = (state.unifiedTabsByWorktree[from] ?? []).flatMap((tab) => {
    const newEntityId = migrations.get(tab.entityId)
    return newEntityId === undefined
      ? []
      : [{ tab, newTabId: migrations.get(tab.id) ?? tab.id, newEntityId }]
  })
  if (moves.length === 0) {
    return null
  }
  const groupId = restoredEditorTargetGroupId(state, to)
  const transitionOf = (s: AppState) => {
    let ok = false
    const next = buildRestoredEditorOwnerTransition(args, (result) => (ok = result.ok), groupId)(s)
    return ok ? next : null
  }
  const planned = transitionOf(state)
  if (!planned) {
    return null
  }
  const renamedFile = (id: string): OpenFile | undefined =>
    planned.patch.openFiles?.find((file) => file.id === id && file.worktreeId === to)
  const command = moveCommand(args, source, moves, groupId, renamedFile, newFileId)
  const rekeys = tabRekeysOf(state, to, groupId, moves)
  const expected = expectContentRekey(
    {
      shows: (cache) => framesShowTabRekeys(cache, from, to, rekeys),
      // Re-checked against the store the frame finds; a move gone stale rekeys nothing.
      patch: (s) => transitionOf(s)?.patch ?? {}
    },
    [...migrations.keys(), ...migrations.values()]
  )
  const sent = sendLayoutApply(state, from, command, {
    apply: (result) => {
      expected.applied((patch) => set(patch), get())
      // Main's answer names the tab the move landed as, a folded one's kept tab included.
      const landed = result.tabId ?? rekeys.at(-1)?.newTabId
      if (activatesTarget && landed) {
        get().setActiveWorktree(to, args.targetExecutionHostId, {
          stateTransition: () => ({
            patch: {},
            activate: true,
            preferredActiveUnifiedTabId: landed
          })
        })
      }
    },
    asToday: () => {
      expected.dropped()
      today()
    },
    refused: () => {
      expected.dropped()
      get().setRestoredEditorOwnerMigrationPending(args.fileId, false)
    }
  })
  if (!sent) {
    expected.dropped()
    return null
  }
  return { ok: true, fileId: newFileId }
}
