// The program's own OSC 7501 report, carried beside a status row for what hooks cannot say
// (progress, its own message, sign-in blocks). Never decides row state; live-only, never persisted.
import {
  isProgramStatusKind,
  isProgramStatusState,
  programStatusStateCarriesProgress,
  type ProgramStatusKind,
  type ProgramStatusState
} from './protocol'
import type { ProgramStatusRecord } from './records'

export type ProgramStatusFacet = {
  state: ProgramStatusState
  /** Only on `blocked`: what the program waits for. */
  kind?: ProgramStatusKind
  /** 0–100, only on `working`/`blocked`. Absent means indeterminate. */
  progress?: number
  /** Display-safe single line (invisible formatting stripped, bounded). */
  message?: string
  /** When the report that produced this facet was read (ms). */
  observedAt: number
}

const PROGRAM_STATUS_MESSAGE_MAX_LENGTH = 400

// Strip bidi/invisible formatting because program messages outside the terminal grid could disguise claims (spec Security).
const INVISIBLE_FORMATTING_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g

/** A program-supplied string made safe and bounded for display, or undefined when empty. */
export function programStatusDisplayText(text: string | undefined): string | undefined {
  const cleaned = text?.replace(INVISIBLE_FORMATTING_RE, '').trim()
  if (!cleaned) {
    return undefined
  }
  return cleaned.length > PROGRAM_STATUS_MESSAGE_MAX_LENGTH
    ? `${cleaned.slice(0, PROGRAM_STATUS_MESSAGE_MAX_LENGTH - 1)}…`
    : cleaned
}

export function programStatusFacetFromRecord(
  record: ProgramStatusRecord,
  observedAt: number
): ProgramStatusFacet {
  const message = programStatusDisplayText(record.msg)
  return {
    state: record.state,
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(message !== undefined ? { message } : {}),
    observedAt
  }
}

/** The fields that make a facet news; `observedAt` is delivery metadata. */
export function programStatusFacetContent(
  facet: ProgramStatusFacet
): readonly [ProgramStatusState, ProgramStatusKind?, number?, string?] {
  return [facet.state, facet.kind, facet.progress, facet.message]
}

export function programStatusFacetsEqual(
  a: ProgramStatusFacet | undefined,
  b: ProgramStatusFacet | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  const left = programStatusFacetContent(a)
  const right = programStatusFacetContent(b)
  return left.every((value, index) => value === right[index])
}

/** Admit a facet from an untrusted wire or IPC value; anything malformed is dropped whole. */
export function normalizeProgramStatusFacet(value: unknown): ProgramStatusFacet | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const obj = Object.fromEntries(Object.entries(value))
  const state = obj.state
  if (
    !isProgramStatusState(state) ||
    typeof obj.observedAt !== 'number' ||
    !Number.isFinite(obj.observedAt)
  ) {
    return undefined
  }
  const kind = state === 'blocked' && isProgramStatusKind(obj.kind) ? obj.kind : undefined
  const progress =
    programStatusStateCarriesProgress(state) &&
    typeof obj.progress === 'number' &&
    Number.isInteger(obj.progress) &&
    obj.progress >= 0 &&
    obj.progress <= 100
      ? obj.progress
      : undefined
  const message =
    typeof obj.message === 'string' ? programStatusDisplayText(obj.message) : undefined
  return {
    state,
    ...(kind !== undefined ? { kind } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(message !== undefined ? { message } : {}),
    observedAt: obj.observedAt
  }
}
