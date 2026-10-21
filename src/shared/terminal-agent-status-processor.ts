import type { AgentStatus } from './agent-title-core'
import type { ParsedAgentStatusPayload } from './agent-status-types'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk,
  type ProgramActivityChange
} from './agent-status-osc'
import { programStatusActivity } from './program-status/activity'
import {
  createProgramStatusProjector,
  type ProgramStatusPayload
} from './program-status/agent-status-projector'
import type { ProgramStatusFacet } from './program-status/facet'

type OffsetPayload = { payload: ParsedAgentStatusPayload; offset: number }

type ProgramStatusSideEffectScan = {
  payloads: ProgramStatusPayload[]
  activity: ProgramActivityChange[]
  /** See ProcessedAgentStatusChunk.programStatusFacet. */
  facet?: ProgramStatusFacet | null
}

/** Stateful per-PTY OSC 7501 reader for side effects: status payloads, activity and the facet. */
export function createProgramStatusSideEffectScanner(): (
  data: string
) => ProgramStatusSideEffectScan {
  const programStatus = createProgramStatusProjector()
  let lastActivity: AgentStatus | null = null
  return (data) => {
    const { payloads, rootChanges, facet } = programStatus.process(data)
    const activity: ProgramActivityChange[] = []
    for (const change of rootChanges) {
      const next = programStatusActivity(change.root)
      if (next !== lastActivity) {
        activity.push({ offset: change.offset, activity: next })
        lastActivity = next
      }
    }
    return { payloads, activity, ...(facet !== undefined ? { facet } : {}) }
  }
}

/** A chunk's OSC 9999 and OSC 7501 payloads in byte order, since either can follow the other. */
function mergeInBandStatusPayloads(
  osc9999: ProcessedAgentStatusChunk,
  osc7501: readonly OffsetPayload[]
): OffsetPayload[] {
  const merged: OffsetPayload[] = osc9999.payloads.map((payload, index) => ({
    payload,
    offset: osc9999.payloadCleanOffsets?.[index] ?? 0
  }))
  for (const entry of osc7501) {
    let index = merged.length
    // `>=`: a stripped 9999 frame at the 7501 frame's end offset was written after it.
    while (index > 0 && merged[index - 1].offset >= entry.offset) {
      index -= 1
    }
    merged.splice(index, 0, entry)
  }
  return merged
}

/**
 * Every in-band agent status a PTY stream carries, for main's side-effect scan: Orca's OSC 9999
 * payloads (stripped from `cleanData`) and the Program Status Protocol, OSC 7501 (left in place).
 */
export function createTerminalAgentStatusProcessor(): (data: string) => ProcessedAgentStatusChunk {
  const processAgentStatusOsc = createAgentStatusOscProcessor()
  const scanProgramStatus = createProgramStatusSideEffectScanner()
  return (data) => {
    const chunk = processAgentStatusOsc(data)
    const scan = scanProgramStatus(chunk.cleanData)
    if (scan.payloads.length === 0 && scan.activity.length === 0 && scan.facet === undefined) {
      return chunk
    }
    const payloads = mergeInBandStatusPayloads(chunk, scan.payloads)
    return {
      ...chunk,
      payloads: payloads.map(({ payload }) => payload),
      lastPayloadCleanOffset: payloads.at(-1)?.offset ?? null,
      payloadCleanOffsets: payloads.map(({ offset }) => offset),
      ...(scan.payloads.length > 0
        ? { programStatusPayloads: new Set(scan.payloads.map(({ payload }) => payload)) }
        : {}),
      ...(scan.payloads.some((entry) => entry.removesRow)
        ? {
            programStatusRowRemovals: new Set(
              scan.payloads.filter((entry) => entry.removesRow).map(({ payload }) => payload)
            )
          }
        : {}),
      ...(scan.activity.length > 0 ? { programActivity: scan.activity } : {}),
      ...(scan.facet !== undefined ? { programStatusFacet: scan.facet } : {})
    }
  }
}
