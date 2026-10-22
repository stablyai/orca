// `layout.apply`'s editor file records and views (see LayoutApplyParams).

import { z } from 'zod'
import type { EditorTabView } from '../editor-tab-view-types'

/** An edit-mode file's restorable record, as the window saves it. */
export const EditorFileRecord = z.object({
  filePath: z.string().min(1),
  relativePath: z.string(),
  language: z.string(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().min(1).optional(),
  readOnly: z.literal(true).optional(),
  liveTail: z.literal(true).optional()
})

const EDITOR_VIEW_MODES: ReadonlySet<unknown> = new Set<EditorTabView['mode']>([
  'edit',
  'diff',
  'markdown-preview',
  'conflict-review',
  'check-details'
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Checks the mode, and an edit view's conflict; the snapshots are the window's own records. */
function isEditorTabView(value: unknown): value is EditorTabView {
  return (
    isRecord(value) &&
    EDITOR_VIEW_MODES.has(value.mode) &&
    (value.mode !== 'edit' || isRecord(value.conflict))
  )
}

/** What a non-plain editor tab shows, with its file's facts; main keeps it in memory only. */
export const EditorViewRecord = z.object({
  view: z.custom<EditorTabView>(isEditorTabView, 'Invalid editor tab view'),
  file: EditorFileRecord.omit({ liveTail: true })
})
