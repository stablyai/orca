import type { WorkItemsCacheSources } from '../cache/cache-model'
import { structuralValuesEqual } from '../../../../../shared/structural-value-equality'

type CandidateField = 'originCandidate' | 'upstreamCandidate'
const CANDIDATE_FIELDS: readonly CandidateField[] = ['originCandidate', 'upstreamCandidate']

/**
 * Folds one answer's raw candidates into the owner's recorded ones, field by field. Older hosts omit candidates: an
 * absent field is unavailable evidence that neither contradicts nor replaces the recorded value. A present field that
 * differs from a recorded present one is an affirmative contradiction, whether or not the other field was reported.
 */
export function foldReportedCandidates(
  recorded: WorkItemsCacheSources | undefined,
  reported: Pick<WorkItemsCacheSources, CandidateField>
) {
  const known = (field: CandidateField) =>
    reported[field] === undefined ? recorded?.[field] : reported[field]
  const contradicted = CANDIDATE_FIELDS.some((field) => {
    const before = recorded?.[field]
    return (
      before !== undefined &&
      reported[field] !== undefined &&
      !structuralValuesEqual(before, reported[field])
    )
  })
  const sources: WorkItemsCacheSources = {
    issues: null,
    prs: null,
    originCandidate: known('originCandidate'),
    upstreamCandidate: known('upstreamCandidate')
  }
  return { sources, contradicted }
}
