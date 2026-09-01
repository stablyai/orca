// Pure assembly for the atomic resolve-duplicate-id mutation (plan §850). The
// grouped dialog collects one choice per duplicate row; this turns those choices
// plus a per-row draft fetch into a single mutation covering the whole group, or
// a typed error when a kept/replaced row's draft cannot be read at this revision.
// It performs the IPC-free shaping so the dialog stays thin and unit-testable.

import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../../shared/types'
import type {
  AgentCatalogMutation,
  CustomAgentDraft
} from '../../../../shared/agent-catalog-snapshot'

export type DuplicateRepairChoice = 'keep' | 'replace' | 'discard'

export type DuplicateRepairRow = {
  repairToken: string
  label: string | null
  baseAgent: BuiltInTuiAgent
  draftAvailability: 'available' | 'too-large'
}

/** Choice per row, keyed by the row's opaque repair token. */
export type DuplicateRepairSelection = Record<string, DuplicateRepairChoice>

/** A row's current draft, or why it cannot be read for keep/replace. */
export type DuplicateRepairDraftResult = CustomAgentDraft | 'too-large' | 'stale'

type ResolveDuplicateMutation = Extract<AgentCatalogMutation, { kind: 'resolve-duplicate-id' }>
type ResolveDuplicateRow = ResolveDuplicateMutation['rows'][number]

export type DuplicateRepairAssembly =
  | { ok: true; mutation: ResolveDuplicateMutation }
  | { ok: false; reason: 'incomplete' | 'multiple-keep' | 'draft-unavailable' }

/** At most one row may keep the id for existing references; the host rejects the
 *  group otherwise, so the dialog blocks submit before it reaches IPC. */
export function countKeepChoices(selection: DuplicateRepairSelection): number {
  return Object.values(selection).filter((choice) => choice === 'keep').length
}

/** Every row in the current group must carry a choice: the host requires the
 *  submitted tokens to equal the whole duplicate group with no omission. */
export function isDuplicateSelectionComplete(
  rows: readonly DuplicateRepairRow[],
  selection: DuplicateRepairSelection
): boolean {
  return rows.every((row) => selection[row.repairToken] !== undefined)
}

export async function assembleDuplicateRepairMutation(args: {
  duplicateId: CustomTuiAgentId
  rows: readonly DuplicateRepairRow[]
  selection: DuplicateRepairSelection
  fetchDraft: (repairToken: string) => Promise<DuplicateRepairDraftResult>
}): Promise<DuplicateRepairAssembly> {
  const { duplicateId, rows, selection, fetchDraft } = args
  if (!isDuplicateSelectionComplete(rows, selection)) {
    return { ok: false, reason: 'incomplete' }
  }
  if (countKeepChoices(selection) > 1) {
    return { ok: false, reason: 'multiple-keep' }
  }
  const mutationRows: ResolveDuplicateRow[] = []
  for (const row of rows) {
    const choice = selection[row.repairToken]
    if (choice === 'discard') {
      mutationRows.push({ repairToken: row.repairToken, action: { kind: 'discard' } })
      continue
    }
    const draft = await fetchDraft(row.repairToken)
    if (draft === 'too-large' || draft === 'stale') {
      return { ok: false, reason: 'draft-unavailable' }
    }
    mutationRows.push({
      repairToken: row.repairToken,
      action:
        choice === 'keep'
          ? { kind: 'keep-for-existing-references', repairedDraft: draft }
          : { kind: 'replace', baseAgent: row.baseAgent, draft }
    })
  }
  return { ok: true, mutation: { kind: 'resolve-duplicate-id', duplicateId, rows: mutationRows } }
}
