// The one place deciding what a row shows from its OSC 7501 facet: the row owns `state`, the facet
// adds what the row's producer cannot say. Shared by desktop, dashboard and mobile.
import type { AgentStatusEntry } from '../agent-status-types'
import type { ProgramStatusFacet } from './facet'
import { programStatusStateCarriesProgress, type ProgramStatusKind } from './protocol'

type ProgramStatusAttention = {
  /** What the program waits for; `undefined` when it did not say. */
  kind?: ProgramStatusKind
  message?: string
}

export type ProgramStatusPresentation = {
  /** Determinate progress (0–100) for a live row. Absent means show no percentage. */
  progress?: number
  /** The program's own line for a live row whose producer has no structured tool preview. */
  message?: string
  /** A block the program reports that the row's own state does not show (e.g. sign-in after a
   *  hook-owned turn ended). Present only while the row reads as not needing the user. */
  attention?: ProgramStatusAttention
}

const EMPTY: ProgramStatusPresentation = Object.freeze({})

type PresentableEntry = Pick<AgentStatusEntry, 'state' | 'programStatus' | 'toolName'>

function rowIsLive(state: AgentStatusEntry['state']): boolean {
  return state === 'working' || state === 'waiting' || state === 'blocked'
}

function facetIsLive(facet: ProgramStatusFacet): boolean {
  return programStatusStateCarriesProgress(facet.state)
}

export function resolveProgramStatusPresentation(
  entry: PresentableEntry | null | undefined
): ProgramStatusPresentation {
  const facet = entry?.programStatus
  if (!entry || !facet) {
    return EMPTY
  }
  const presentation: ProgramStatusPresentation = {}
  // Why both live: a stale facet from the program's last run must not paint a finished row.
  const bothLive = facetIsLive(facet) && rowIsLive(entry.state)
  if (bothLive && facet.progress !== undefined) {
    presentation.progress = facet.progress
  }
  // Structured hook previews ("Edit: src/app.ts") beat the program's free text.
  if (bothLive && facet.message && !entry.toolName?.trim()) {
    presentation.message = facet.message
  }
  if (facet.state === 'blocked' && entry.state !== 'waiting' && entry.state !== 'blocked') {
    presentation.attention = {
      ...(facet.kind ? { kind: facet.kind } : {}),
      ...(facet.message ? { message: facet.message } : {})
    }
  }
  return presentation
}

/** Short label for an attention block, e.g. in a row's secondary line or a tooltip. */
export function programStatusAttentionLabel(attention: ProgramStatusAttention): string {
  switch (attention.kind) {
    case 'auth':
      return 'Sign-in required'
    case 'permission':
      return 'Needs approval'
    case 'question':
      return 'Needs an answer'
    case undefined:
      return 'Needs you'
  }
}

/** One line for a row: "Sign-in required: Session expired". */
export function programStatusAttentionLine(attention: ProgramStatusAttention): string {
  const label = programStatusAttentionLabel(attention)
  return attention.message ? `${label}: ${attention.message}` : label
}
