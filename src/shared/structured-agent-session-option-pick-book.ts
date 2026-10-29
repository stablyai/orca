import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import {
  readRuntimePermissionReport,
  runtimePermissionReportKey
} from './structured-agent-session-permission-option'

/** Picks still on their way to the host, by option. Each write bumps the generation, so an older reply or read never overwrites a newer pick. */
export type StructuredOptionPickBook = {
  pending: Record<string, string>
  generation: number
  /** The agent's permission report as last seen, and the one the pending mode picks were made over. */
  permissionReport: string | null
  permissionPickedOver: string | null
  /** Modes picked since that report, latest last. */
  permissionPicks: string[]
}

export type StructuredOptionPick = { id: string; encoded: string; generation: number }

export function createStructuredOptionPickBook(): StructuredOptionPickBook {
  return {
    pending: {},
    generation: 0,
    permissionReport: null,
    permissionPickedOver: null,
    permissionPicks: []
  }
}

/** A new session or fence: replies to earlier picks no longer apply. */
export function resetStructuredOptionPickBook(book: StructuredOptionPickBook): void {
  book.generation += 1
  book.pending = {}
  forgetStructuredPermissionPicks(book)
}

function forgetStructuredPermissionPicks(book: StructuredOptionPickBook): void {
  book.permissionPickedOver = null
  book.permissionPicks = []
}

/** A different report is the agent's answer to the latest pick, whether or not it took it; one that
 *  took an earlier quick pick leaves the latest waiting over it. */
export function observeStructuredPermissionReport(
  book: StructuredOptionPickBook,
  summary: unknown,
  fence: number | null
): void {
  const key = runtimePermissionReportKey(summary, fence)
  book.permissionReport = key
  if (book.permissionPickedOver === null || key === book.permissionPickedOver) {
    return
  }
  const took = earlierPermissionPickTaken(book, summary, fence)
  if (key !== null && took >= 0) {
    book.permissionPickedOver = key
    book.permissionPicks = book.permissionPicks.slice(took + 1)
    return
  }
  forgetStructuredPermissionPicks(book)
}

/** Whether the latest mode pick still stands in for this report; pure, so a render agrees with the next observation. */
export function structuredPermissionPickStands(
  book: StructuredOptionPickBook,
  summary: unknown,
  fence: number | null
): boolean {
  const key = runtimePermissionReportKey(summary, fence)
  return (
    book.permissionPickedOver !== null &&
    key !== null &&
    (key === book.permissionPickedOver || earlierPermissionPickTaken(book, summary, fence) >= 0)
  )
}

/** The index of an earlier, not the latest, pending pick that this report shows the agent took. */
function earlierPermissionPickTaken(
  book: StructuredOptionPickBook,
  summary: unknown,
  fence: number | null
): number {
  const mode = readRuntimePermissionReport(summary, fence)?.mode
  const took = typeof mode === 'string' ? book.permissionPicks.lastIndexOf(mode) : -1
  return took < book.permissionPicks.length - 1 ? took : -1
}

/** `shownAtOnce` picks are committed before the write, so they hold nothing pending. */
export function beginStructuredOptionPick(
  book: StructuredOptionPickBook,
  id: string,
  encoded: string,
  shownAtOnce: boolean
): StructuredOptionPick {
  if (!shownAtOnce) {
    book.pending[id] = encoded
  }
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    if (book.permissionPickedOver === null) {
      book.permissionPickedOver = book.permissionReport
      book.permissionPicks = []
    }
    book.permissionPicks.push(encoded)
  }
  book.generation += 1
  return { id, encoded, generation: book.generation }
}

export function isLatestStructuredOptionPick(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick
): boolean {
  return book.generation === pick.generation
}

/** What an accepted reply commits: everything it returned for the latest write, only its own option when another option was picked since, nothing once this option was picked again. */
export function structuredOptionPickCommit(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick,
  returned: Readonly<Record<string, string>> | undefined
): Record<string, string> | null {
  const values = returned ?? { [pick.id]: pick.encoded }
  if (isLatestStructuredOptionPick(book, pick)) {
    return { ...values }
  }
  return book.pending[pick.id] === pick.encoded
    ? { [pick.id]: values[pick.id] ?? pick.encoded }
    : null
}

/** A refused mode pick no longer stands in for the agent's report. */
export function settleStructuredOptionPick(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick,
  accepted = true
): void {
  if (book.pending[pick.id] === pick.encoded) {
    delete book.pending[pick.id]
  }
  if (
    !accepted &&
    pick.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
    isLatestStructuredOptionPick(book, pick)
  ) {
    forgetStructuredPermissionPicks(book)
  }
}

export function structuredOptionPickIsPending(book: StructuredOptionPickBook, id: string): boolean {
  return book.pending[id] !== undefined
}

/** The pick a new one of `id` must wait for: a repeat waits, other options go together, and a starting provider holds nothing. */
export function structuredOptionPickBlockingId(
  book: StructuredOptionPickBook,
  id: string,
  providerStarting: boolean
): string | null {
  return !providerStarting && structuredOptionPickIsPending(book, id) ? id : null
}
