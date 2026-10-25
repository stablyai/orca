// Projects OSC 7501 records onto agent-status payloads so they ride the OSC 9999 terminal-status ingress.
import type { AgentStatusState, ParsedAgentStatusPayload } from '../agent-status-types'
import type { AgentSubagentSnapshot, AgentSubagentState } from '../agent-status-subagent-snapshot'
import { AGENT_SUBAGENT_ID_MAX_LENGTH } from '../agent-status-subagent-snapshot'
import type { AgentTurnOutcome } from '../agent-turn-outcome'
import { createProgramStatusOscScanner } from './osc-scanner'
import {
  programStatusDisplayText,
  programStatusFacetFromRecord,
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from './facet'
import { isTurnScopedProgramStatusKind } from './protocol'
import { ProgramStatusRecordSet, type ProgramStatusRecord } from './records'

/** OSC 7501 `app` ids whose Orca agent id differs. Other apps pass through verbatim. */
const APP_TO_AGENT_TYPE: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'grok-build': 'grok'
}

function agentTypeForProgramStatusApp(app: string | undefined): string | undefined {
  if (app === undefined) {
    return undefined
  }
  // Why hasOwn: `app=constructor` must not resolve to an Object.prototype member.
  return Object.hasOwn(APP_TO_AGENT_TYPE, app) ? APP_TO_AGENT_TYPE[app] : app
}

/** A child id within the snapshot cap; long ids keep their leaf and a hash of the whole path. */
function boundedChildId(id: string): string {
  if (id.length <= AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return id
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0
  }
  const prefix = `${hash.toString(16).padStart(8, '0')}~`
  return prefix + id.slice(-(AGENT_SUBAGENT_ID_MAX_LENGTH - prefix.length))
}

function blockedState(record: ProgramStatusRecord): 'waiting' | 'blocked' {
  // Why: Orca's hooks report approvals and questions as `waiting`.
  return isTurnScopedProgramStatusKind(record.kind) ? 'waiting' : 'blocked'
}

function subagentState(record: ProgramStatusRecord): AgentSubagentState | null {
  switch (record.state) {
    case 'working':
      return 'working'
    case 'blocked':
      return blockedState(record)
    case 'idle':
      return 'idle'
    case 'done':
    case 'error':
      // A finished child is not a live child row.
      return null
  }
}

type RootProjection = {
  state: AgentStatusState
  outcome?: AgentTurnOutcome
  sessionBoundary?: true
}

/** The root as a live program: undefined once the program ended (prompt start, reset), even while
 *  its finished record is kept for display. */
type ProgramStatusRootChange = { offset: number; root: ProgramStatusRecord | undefined }

/** `removesRow`: no records remain (clear, reset, ended mid-work), so the program's row goes too. */
export type ProgramStatusPayload = {
  payload: ParsedAgentStatusPayload
  offset: number
  removesRow?: true
}

type ProgramStatusProjector = {
  /** Return lifecycle payloads/root changes in chunk order (including unchanged store projections); facet is new, null when removed,
   * or absent when unchanged. */
  process: (data: string) => {
    payloads: ProgramStatusPayload[]
    rootChanges: ProgramStatusRootChange[]
    facet?: ProgramStatusFacet | null
  }
}

export function createProgramStatusProjector(now: () => number = Date.now): ProgramStatusProjector {
  const scan = createProgramStatusOscScanner()
  const records = new ProgramStatusRecordSet()
  let lastRoot: RootProjection | null = null
  let lastKey: string | null = null
  let rootStateStartedAt = 0
  let lastFacet: ProgramStatusFacet | undefined
  // Set when the program ends; the next projection starts a new invocation.
  let invocationEnded = false
  let reportedSinceEnd = false
  const childStartedAt = new Map<string, number>()

  const projectRoot = (
    root: ProgramStatusRecord | undefined,
    newInvocation: boolean
  ): RootProjection | null => {
    if (!root) {
      // Why a boundary, not a verdict: a dropped record proves the program ended, not how.
      return lastRoot !== null && lastRoot.sessionBoundary !== true
        ? { state: 'done', sessionBoundary: true }
        : null
    }
    switch (root.state) {
      case 'working':
        return { state: 'working' }
      case 'blocked':
        return { state: blockedState(root) }
      case 'done':
        return { state: 'done', outcome: 'success' }
      case 'error':
        return { state: 'done', outcome: 'failure' }
      case 'idle':
        // Idle may follow startup work (Codex), so it proves rest, not cancellation; interrupt keystrokes own that verdict.
        // Keep unseen done results when the same invocation rests.
        return !newInvocation && lastRoot?.state === 'done' && lastRoot.sessionBoundary !== true
          ? lastRoot
          : { state: 'done', sessionBoundary: true }
    }
  }

  const snapshotChildren = (): AgentSubagentSnapshot[] => {
    const at = now()
    const live = new Set<string>()
    const children: AgentSubagentSnapshot[] = []
    for (const record of records.descendants()) {
      const state = subagentState(record)
      if (record.id === null || state === null) {
        continue
      }
      const id = boundedChildId(record.id)
      live.add(id)
      const startedAt = childStartedAt.get(id) ?? at
      childStartedAt.set(id, startedAt)
      const agentType = agentTypeForProgramStatusApp(record.app)
      const description =
        programStatusDisplayText(record.title) ?? programStatusDisplayText(record.msg)
      children.push({
        id,
        state,
        startedAt,
        ...(agentType ? { agentType } : {}),
        ...(description ? { description } : {})
      })
    }
    for (const id of childStartedAt.keys()) {
      if (!live.has(id)) {
        childStartedAt.delete(id)
      }
    }
    return children
  }

  const project = (): ParsedAgentStatusPayload | null => {
    const root = records.root()
    const newInvocation = invocationEnded
    invocationEnded = false
    const projection = projectRoot(root, newInvocation)
    if (projection === null) {
      lastRoot = null
      lastKey = null
      return null
    }
    // Why on a new invocation too: an identical result from the next run is still news.
    if (
      newInvocation ||
      projection.state !== lastRoot?.state ||
      projection.outcome !== lastRoot?.outcome
    ) {
      rootStateStartedAt = now()
      lastKey = null
    }
    lastRoot = projection
    const agentType = agentTypeForProgramStatusApp(root?.app)
    const msg = programStatusDisplayText(root?.msg)
    const subagents = snapshotChildren()
    const payload: ParsedAgentStatusPayload = {
      state: projection.state,
      prompt: '',
      ...(agentType ? { agentType } : {}),
      // Live work names what it is doing or waiting on; a finished turn names its result.
      ...(msg && projection.state !== 'done' ? { toolInput: msg } : {}),
      ...(msg && projection.state === 'done' && projection.sessionBoundary !== true
        ? { lastAssistantMessage: msg }
        : {}),
      ...(projection.sessionBoundary ? { sessionBoundary: true } : {}),
      ...(subagents.length > 0 ? { subagents } : {}),
      mainAgent: {
        state: projection.state,
        ...(projection.outcome ? { outcome: projection.outcome } : {}),
        stateStartedAt: rootStateStartedAt
      }
    }
    // Deduplicate redraw reports so only changed payloads reach the store.
    const key = JSON.stringify(payload)
    if (key === lastKey) {
      return null
    }
    lastKey = key
    return payload
  }

  return {
    process: (data) => {
      const events = scan(data)
      const payloads: ProgramStatusPayload[] = []
      const rootChanges: ProgramStatusRootChange[] = []
      const facetBefore = lastFacet
      for (const event of events) {
        let changed: boolean
        switch (event.type) {
          case 'query':
            // Answered by the terminal emulator that owns replies for this chunk.
            continue
          case 'report':
            changed = records.apply(event.report)
            reportedSinceEnd = true
            break
          case 'prompt-start':
            changed = records.endProgram()
            break
          case 'full-reset':
            changed = records.reset()
            break
        }
        const ended = event.type !== 'report'
        const endsInvocation = ended && reportedSinceEnd
        if (endsInvocation) {
          // The kept done/error record is for display; the program itself no longer speaks.
          reportedSinceEnd = false
          rootChanges.push({ offset: event.offset, root: undefined })
        }
        if (changed) {
          const root = records.root()
          if (!ended) {
            rootChanges.push({ offset: event.offset, root })
          }
          const facet = root ? programStatusFacetFromRecord(root, now()) : undefined
          // Keep the earlier facet object (and its observedAt) when the report repeats it.
          lastFacet = programStatusFacetsEqual(lastFacet, facet) ? lastFacet : facet
          const payload = project()
          // A removal is news even when the last projection was already an at-rest boundary.
          if (root === undefined && records.descendants().length === 0) {
            payloads.push({
              payload: payload ?? { state: 'done', prompt: '', sessionBoundary: true },
              offset: event.offset,
              removesRow: true
            })
          } else if (payload) {
            payloads.push({ payload, offset: event.offset })
          }
        }
        // After the ending event's own projection, so only the next report opens a new invocation.
        if (endsInvocation) {
          invocationEnded = true
        }
      }
      if (lastFacet === facetBefore) {
        return { payloads, rootChanges }
      }
      return { payloads, rootChanges, facet: lastFacet ?? null }
    }
  }
}
