// The shapes, errors and pure helpers of the shared automation details loader.
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'
import { compareAutomationRunsNewestFirst } from '../../../../../shared/automations/history/automation-run-cursor'
import { AutomationHostScopeUnsupportedError } from '../hosts/automation-capability-probe'
import type { AutomationOwnerContinuity } from '../hosts/automation-host-owner'

/** Older runs past this many are left to the Automations page. */
export const AUTOMATION_DETAILS_MAX_RUNS = 100
export const AUTOMATION_DETAILS_MORE_RUNS = 10

export type AutomationReadProblem = {
  /** `unsupported`: the host is too old for this read or action. */
  kind: 'unsupported' | 'failed'
  message: string
}

export type AutomationDefinitionSlice = {
  status: 'loading' | 'ready' | 'error' | 'deleted'
  value: Automation | null
  error: AutomationReadProblem | null
  /** The value is from an earlier read; the latest one failed. */
  stale: boolean
}

export type AutomationRunsSlice = {
  status: 'loading' | 'ready' | 'error'
  value: AutomationRun[]
  error: AutomationReadProblem | null
  stale: boolean
  nextCursor: string | null
  loadingMore: boolean
  capacityError?: AutomationReadProblem | null
  olderError?: AutomationReadProblem | null
  coverageIds?: readonly string[]
  paged?: boolean
  /** Showing the most this surface keeps; older runs are on the Automations page. */
  capped: boolean
}

export type AutomationSelectedRun = {
  runId: string
  status: 'loading' | 'in-window' | 'ready' | 'run-missing' | 'unsupported' | 'error'
  run: AutomationRun | null
  error?: AutomationReadProblem
}

export type AutomationDetailsContinuity = 'same' | 'checking' | 'retired' | 'unpaired'

export type AutomationDetailsSnapshot = {
  acknowledgedRun?:
    | (Pick<AutomationRun, 'id' | 'status'> &
        Partial<Pick<AutomationRun, 'createdAt' | 'scheduledFor' | 'title'>>)
    | null
  owner: AutomationOwnerRef
  continuity: AutomationDetailsContinuity
  definition: AutomationDefinitionSlice
  runs: AutomationRunsSlice
  selected: AutomationSelectedRun | null
  expandedRunId?: string | null
  /** A definition mutation (switch, save, delete) is in flight; others wait for it. */
  mutating: boolean
}

export type AutomationDetailsDeps = {
  showAutomation: (owner: AutomationOwnerRef, id: string) => Promise<Automation>
  listRunsPage: (
    owner: AutomationOwnerRef,
    automationId: string,
    options: { limit: number; cursor?: string }
  ) => Promise<AutomationRunsPage>
  readRun: (
    owner: AutomationOwnerRef,
    automationId: string,
    runId: string
  ) => Promise<AutomationRunRead>
  evaluateOwner: (owner: AutomationOwnerRef) => AutomationOwnerContinuity
}

/** Thrown, before anything is sent, when the captured owner no longer names the same machine. */
export class AutomationOwnerChangedError extends Error {
  constructor(readonly continuity: Exclude<AutomationDetailsContinuity, 'same'>) {
    super(
      continuity === 'checking'
        ? 'Still checking this computer.'
        : 'This computer changed since the automation was read.'
    )
    this.name = 'AutomationOwnerChangedError'
  }
}

/** Thrown when another definition change is still in flight. */
export class AutomationMutationBusyError extends Error {
  constructor() {
    super('Another change to this automation is still saving.')
    this.name = 'AutomationMutationBusyError'
  }
}

export function automationReadProblem(error: unknown): AutomationReadProblem {
  return {
    kind: error instanceof AutomationHostScopeUnsupportedError ? 'unsupported' : 'failed',
    message: error instanceof Error ? error.message : String(error)
  }
}

export function isAutomationNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Automation not found')
}

export const DEFINITION_LOADING: AutomationDefinitionSlice = {
  status: 'loading',
  value: null,
  error: null,
  stale: false
}

export const RUNS_LOADING: AutomationRunsSlice = {
  status: 'loading',
  value: [],
  error: null,
  stale: false,
  nextCursor: null,
  loadingMore: false,
  capped: false
}

export function newestFirst(runs: AutomationRun[]): AutomationRun[] {
  return [...runs].sort(compareAutomationRunsNewestFirst)
}

/** The first page replaces what it covers; rows already paged in past it stay. */
export function mergeRuns(firstPage: AutomationRun[], previous: AutomationRun[]): AutomationRun[] {
  const ids = new Set(firstPage.map((run) => run.id))
  const boundary = firstPage.at(-1)
  const kept = boundary
    ? previous.filter(
        (run) => !ids.has(run.id) && compareAutomationRunsNewestFirst(run, boundary) > 0
      )
    : []
  return newestFirst([...firstPage, ...kept]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
}

export function reconcileAutomationRuns(
  page: AutomationRunsPage,
  previous: AutomationRunsSlice,
  recentLimit: number,
  paged: boolean,
  acknowledgedRunIds: ReadonlySet<string>
): AutomationRunsSlice {
  const firstPage = newestFirst(page.runs).slice(0, recentLimit)
  const ids = new Set(firstPage.map((run) => run.id))
  const acknowledged = previous.value.filter(
    (run) => acknowledgedRunIds.has(run.id) && !ids.has(run.id)
  )
  const previousCoverage = new Set(
    previous.coverageIds ??
      previous.value.filter((run) => !acknowledgedRunIds.has(run.id)).map((run) => run.id)
  )
  const continuous = paged && firstPage.some((run) => previousCoverage.has(run.id))
  const covered = continuous && page.nextCursor ? mergeRuns(firstPage, previous.value) : firstPage
  const value = newestFirst([
    ...new Map([...acknowledged, ...covered].map((run) => [run.id, run])).values()
  ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
  const nextCursor = continuous && page.nextCursor ? previous.nextCursor : page.nextCursor
  return {
    status: 'ready',
    value,
    error: null,
    olderError: previous.olderError,
    coverageIds: value
      .filter((run) => ids.has(run.id) || (continuous && previousCoverage.has(run.id)))
      .map((run) => run.id),
    paged: continuous,
    stale: false,
    nextCursor,
    loadingMore: nextCursor === previous.nextCursor && previous.loadingMore,
    capped: value.length >= AUTOMATION_DETAILS_MAX_RUNS
  }
}

/**
 * Whether a failed action may still have happened on the host: it was sent and no answer came back
 * (a timeout or a lost connection). A refusal before sending, or the host's own error reply, is a
 * definite failure.
 */
export function automationActionOutcomeUnknown(error: unknown): boolean {
  if (
    error instanceof AutomationOwnerChangedError ||
    error instanceof AutomationMutationBusyError ||
    error instanceof AutomationHostScopeUnsupportedError ||
    (error instanceof Error && error.name === 'RuntimeConnectionChangedBeforeSendError')
  ) {
    return false
  }
  if (error instanceof Error && error.name === 'RuntimeRpcCallError') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
    return code.includes('timeout') || code === 'unavailable' || code === 'disconnected'
  }
  return true
}

export function acknowledgedAutomationRun(
  snapshot: AutomationDetailsSnapshot,
  automationId: string
): AutomationRun | null {
  const ack = snapshot.acknowledgedRun
  if (!ack || snapshot.runs.value.some((run) => run.id === ack.id)) {
    return null
  }
  return {
    id: ack.id,
    automationId,
    title: ack.title ?? ack.id,
    status: ack.status,
    createdAt: ack.createdAt ?? 0,
    scheduledFor: ack.scheduledFor ?? 0,
    trigger: 'manual',
    sessionKind: 'chat',
    workspaceId: null,
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null
  }
}
