import type { AgentStatus } from '../agent-status/title/agent-title-core'
import type { ParsedAgentStatusPayload } from '../agent-status/contracts/agent-status-types'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk,
  type ProgramActivityChange
} from '../agent-status/transport/agent-status-osc'
import { programStatusActivity } from './activity'
import { createProgramStatusProjector, type ProgramStatusPayload } from './agent-status-projector'
import type { ProgramStatusFacet } from './facet'

type OffsetPayload = { payload: ParsedAgentStatusPayload; offset: number }

type ProgramStatusSideEffectScan = {
  payloads: ProgramStatusPayload[]
  readiness?: { payload: ParsedAgentStatusPayload | null; offset: number }
  activity: ProgramActivityChange[]
  /** See ProcessedAgentStatusChunk.programStatusFacet. */
  facet?: ProgramStatusFacet | null
}

/** Stateful per-PTY OSC 7501 reader for side effects: status payloads, activity and the facet. */
export function createProgramStatusSideEffectScanner(): (
  data: string,
  readinessBoundary?: number
) => ProgramStatusSideEffectScan {
  const programStatus = createProgramStatusProjector()
  let lastActivity: AgentStatus | null = null
  return (data, readinessBoundary) => {
    const { payloads, rootChanges, facet, readiness } = programStatus.process(
      data,
      readinessBoundary
    )
    const activity: ProgramActivityChange[] = []
    for (const change of rootChanges) {
      const next = programStatusActivity(change.root)
      if (next !== lastActivity) {
        activity.push({ offset: change.offset, activity: next })
        lastActivity = next
      }
    }
    return { payloads, activity, readiness, ...(facet !== undefined ? { facet } : {}) }
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
    // At equal offsets, insert 7501 before stripped 9999, which followed it in the raw bytes.
    while (index > 0 && merged[index - 1].offset >= entry.offset) {
      index -= 1
    }
    merged.splice(index, 0, entry)
  }
  return merged
}

/** Merge stripped OSC 9999 and retained OSC 7501 statuses for main’s side-effect scan. */
export function createTerminalAgentStatusProcessor(): (
  data: string,
  readinessBoundary?: number
) => ProcessedAgentStatusChunk {
  let rawStart = 0
  const stripped: { cleanOffset: number; rawEnd: number }[] = []
  let latestHook: ProcessedAgentStatusChunk['readinessStatus']
  const processAgentStatusOsc = createAgentStatusOscProcessor({
    begin: (carriedLength) => {
      rawStart = -carriedLength
      stripped.length = 0
      latestHook = undefined
    },
    stripped: (cleanOffset, rawEnd, payload) => {
      stripped.push({ cleanOffset, rawEnd })
      if (payload) {
        latestHook = { payload, offset: rawEnd, fromProgram: false }
      }
    }
  })
  const scanProgramStatus = createProgramStatusSideEffectScanner()
  return (data, readinessBoundary = -1) => {
    const chunk = processAgentStatusOsc(data)
    let cleanBoundary = readinessBoundary
    if (readinessBoundary >= 0) {
      let delta = rawStart
      for (const frame of stripped) {
        if (frame.rawEnd > readinessBoundary) {
          break
        }
        delta = frame.rawEnd - frame.cleanOffset
      }
      cleanBoundary -= delta
    }
    const scan = scanProgramStatus(chunk.cleanData, cleanBoundary)
    let readinessStatus = latestHook
    if (scan.readiness) {
      let delta = rawStart
      for (const frame of stripped) {
        if (frame.cleanOffset >= scan.readiness.offset) {
          break
        }
        delta = frame.rawEnd - frame.cleanOffset
      }
      const offset = scan.readiness.offset + delta
      if (!readinessStatus || offset > readinessStatus.offset) {
        readinessStatus = { payload: scan.readiness.payload, offset, fromProgram: true }
      }
    }
    if (
      scan.payloads.length === 0 &&
      scan.activity.length === 0 &&
      scan.facet === undefined &&
      !readinessStatus
    ) {
      return chunk
    }
    const payloads = mergeInBandStatusPayloads(chunk, scan.payloads)
    return {
      ...chunk,
      ...(readinessStatus ? { readinessStatus } : {}),
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
