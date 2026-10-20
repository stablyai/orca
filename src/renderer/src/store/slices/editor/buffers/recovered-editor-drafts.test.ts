import { expect, it, vi } from 'vitest'
import type { RecoveredEditorDraft } from '../../../../../../shared/workspace-session-state-types'
import {
  appendRecoveredEditorDrafts,
  recoveredEditorDraftId,
  recoveredEditorDraftsSessionField
} from './recovered-editor-drafts'

function draft(recoveredAt: number, text = 'draft', worktreeId = 'wt'): RecoveredEditorDraft {
  return { filePath: `/repo/${recoveredAt}.ts`, worktreeId, draft: text, recoveredAt }
}

it('keeps the 20 newest across restarts and the rest for this launch only', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const existing = Array.from({ length: 20 }, (_, index) => draft(index))

  const kept = appendRecoveredEditorDrafts(existing, [draft(100)])

  expect(kept).toHaveLength(21)
  expect(kept.find((entry) => entry.recoveredAt === 0)?.keptForThisLaunchOnly).toBe(true)
  expect(recoveredEditorDraftsSessionField(kept).recoveredEditorDrafts).toHaveLength(20)
})

it('keeps drafts past 2 MB for this launch only, never dropping them', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const big = 'x'.repeat(1024 * 1024)

  const kept = appendRecoveredEditorDrafts([draft(1, big), draft(2, big)], [draft(3, big)])

  expect(kept.map((entry) => [entry.recoveredAt, entry.keptForThisLaunchOnly])).toEqual([
    [1, true],
    [2, undefined],
    [3, undefined]
  ])
})

it('writes an empty list rather than omitting it, so a stale copy cannot return', () => {
  expect(recoveredEditorDraftsSessionField([])).toEqual({ recoveredEditorDrafts: [] })
})

it('tells apart the same file recovered in two workspaces', () => {
  expect(recoveredEditorDraftId(draft(1, 'a', 'wt-1'))).not.toBe(
    recoveredEditorDraftId(draft(1, 'a', 'wt-2'))
  )
})

it('tells apart two id-less drafts (an older build dropped ids) by their text', () => {
  expect(recoveredEditorDraftId(draft(1, 'a'))).not.toBe(recoveredEditorDraftId(draft(1, 'b')))
})
