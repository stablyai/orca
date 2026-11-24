import { structuralValuesEqual } from '../../collections/structural-value-equality'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'

export type StructuredAgentSubmission = Omit<AgentJournalSubmission, 'writtenAt'>
export type SubmissionReceipts = Pick<ReadonlyMap<string, number>, 'get'>

const indexes = new WeakMap<readonly StructuredAgentSubmission[], ReadonlyMap<string, number>>()

export function structuredAgentSubmissionIndex(submissions: readonly StructuredAgentSubmission[]) {
  let index = indexes.get(submissions)
  if (!index) {
    index = new Map(
      submissions.map((submission, position) => [submission.clientMessageId, position])
    )
    indexes.set(submissions, index)
  }
  return index
}

// Receipt versions share all untouched branches, so queued renders keep their own snapshot.
type ReceiptBranch = readonly (ReceiptBranch | number | undefined)[]
const TOP_SHIFT = 30
const EMPTY_BRANCH: ReceiptBranch = []

function updateReceipt(
  branch: ReceiptBranch,
  position: number,
  shift: number,
  receipt: number | undefined
): ReceiptBranch {
  const slot = (position >>> shift) & 31
  const previous = branch[slot]
  const next =
    shift === 0
      ? receipt
      : updateReceipt(
          typeof previous === 'object' ? previous : EMPTY_BRANCH,
          position,
          shift - 5,
          receipt
        )
  if (next === previous || (previous === undefined && next === EMPTY_BRANCH)) {
    return branch
  }
  const updated = branch.slice()
  updated[slot] = next
  return updated
}

class IndexedSubmissionReceipts implements SubmissionReceipts {
  constructor(
    private readonly index: ReadonlyMap<string, number>,
    private readonly root: ReceiptBranch = EMPTY_BRANCH
  ) {}

  get(id: string): number | undefined {
    const position = this.index.get(id)
    if (position === undefined) {
      return undefined
    }
    let branch = this.root
    for (let shift = TOP_SHIFT; shift > 0; shift -= 5) {
      const child = branch[(position >>> shift) & 31]
      if (typeof child !== 'object') {
        return undefined
      }
      branch = child
    }
    const value = branch[position & 31]
    return typeof value === 'number' ? value : undefined
  }

  withRecords(records: readonly AgentJournalSubmission[]): IndexedSubmissionReceipts {
    let next = this.root
    for (const { clientMessageId, writtenAt } of records) {
      const position = this.index.get(clientMessageId)
      if (position !== undefined) {
        next = updateReceipt(next, position, TOP_SHIFT, writtenAt)
      }
    }
    return next === this.root ? this : new IndexedSubmissionReceipts(this.index, next)
  }
}

export type StructuredAgentSubmissions = {
  submissions: StructuredAgentSubmission[]
  writtenAtById: SubmissionReceipts
}

export function splitStructuredAgentSubmissions(
  records: readonly AgentJournalSubmission[]
): StructuredAgentSubmissions {
  const submissions = records.map((record) => {
    const { writtenAt: _writtenAt, ...submission } = record
    return submission
  })
  return {
    submissions,
    writtenAtById: new IndexedSubmissionReceipts(
      structuredAgentSubmissionIndex(submissions)
    ).withRecords(records)
  }
}

export function materializeStructuredAgentSubmissions({
  submissions,
  writtenAtById
}: StructuredAgentSubmissions): AgentJournalSubmission[] {
  return submissions.map((submission) => {
    const writtenAt = writtenAtById.get(submission.clientMessageId)
    return writtenAt === undefined ? submission : { ...submission, writtenAt }
  })
}

/** A live restatement only needs to compare records actually named by the batch. */
export function applySubmissionReceipts(
  state: StructuredAgentSubmissions,
  records: readonly AgentJournalSubmission[]
): StructuredAgentSubmissions | null {
  if (!(state.writtenAtById instanceof IndexedSubmissionReceipts)) {
    return null
  }
  const positions = structuredAgentSubmissionIndex(state.submissions)
  for (const { writtenAt: _, ...record } of records) {
    const position = positions.get(record.clientMessageId)
    if (position === undefined || !structuralValuesEqual(state.submissions[position], record)) {
      return null
    }
  }
  return {
    submissions: state.submissions,
    writtenAtById: state.writtenAtById.withRecords(records)
  }
}
