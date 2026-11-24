import type { editor } from 'monaco-editor'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import {
  getCombinedDiffViews,
  hasUnsavedEdit,
  type CombinedDiffViewLease
} from './combined-diff-view-cache'

const mountedDraftReaders = new Map<CombinedDiffViewLease, () => CombinedDiffCloseSection[]>()
export const liveCombinedDiffModelEdits = new WeakMap<editor.IStandaloneCodeEditor, string>()

type CombinedDiffCloseSection = Pick<
  DiffSection,
  'key' | 'dirty' | 'saveConflict' | 'modifiedContent'
>
type CombinedDiffDraft = Pick<CombinedDiffCloseSection, 'modifiedContent' | 'saveConflict'>
export type CombinedDiffCloseDrafts = ReadonlyMap<string, CombinedDiffDraft>

export function registerMountedCombinedDiffDrafts(
  lease: CombinedDiffViewLease,
  read: () => CombinedDiffCloseSection[]
): () => void {
  mountedDraftReaders.set(lease, read)
  return () => mountedDraftReaders.delete(lease)
}

export function readCombinedDiffCloseDrafts(): CombinedDiffCloseDrafts {
  const views = new Map<string, { worktreeId: string; sections: CombinedDiffCloseSection[] }>(
    [...getCombinedDiffViews()].map(([viewKey, memory]) => [
      viewKey,
      { worktreeId: memory.worktreeId, sections: memory.view?.sections ?? [] }
    ])
  )
  for (const [lease, read] of mountedDraftReaders) {
    if (!lease.revoked) {
      views.set(lease.viewKey, { worktreeId: lease.worktreeId, sections: read() })
    }
  }
  const drafts = new Map<string, CombinedDiffDraft>()
  for (const [viewKey, { worktreeId, sections }] of views) {
    for (const section of sections) {
      if (hasUnsavedEdit(section)) {
        drafts.set(JSON.stringify([worktreeId, viewKey, section.key]), section)
      }
    }
  }
  return drafts
}

export function hasUnconfirmedCombinedDiffDrafts(
  drafts: CombinedDiffCloseDrafts,
  confirmed: CombinedDiffCloseDrafts
): boolean {
  for (const [key, draft] of drafts) {
    const accepted = confirmed.get(key)
    if (
      !accepted ||
      accepted.modifiedContent !== draft.modifiedContent ||
      accepted.saveConflict !== draft.saveConflict
    ) {
      return true
    }
  }
  return false
}
