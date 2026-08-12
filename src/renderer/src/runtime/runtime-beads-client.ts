import type {
  BeadsIssue,
  BeadsIssueDetails,
  BeadsIssuePreset,
  BeadsIssueStatus,
  BeadsWorkspaceStatus
} from '../../../shared/beads-types'
import type { GlobalSettings } from '../../../shared/types'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  BEADS_QUERY_FILTER_RUNTIME_CAPABILITY,
  BEADS_TASK_SOURCE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  hasRuntimeRpcErrorCode,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'

export type RuntimeBeadsSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type BeadsStatusResult = { status: BeadsWorkspaceStatus }
export type BeadsListIssuesResult = { issues: BeadsIssue[]; status: BeadsWorkspaceStatus }
export type BeadsIssueResult = { issue: BeadsIssue | null }
export type BeadsUpdateIssueResult = { issue: BeadsIssue | null; status: BeadsWorkspaceStatus }
export type BeadsIssueDetailsResult = { details: BeadsIssueDetails | null }

// Why: pre-beads remote hosts silently lack the 'beads.*' methods; a typed
// rejection lets the UI show 'missing-task-source-capability' instead of an
// empty issue list.
export class BeadsTaskSourceUnsupportedError extends Error {
  constructor(message = 'This remote runtime must be updated to read Beads issues.') {
    super(message)
    this.name = 'BeadsTaskSourceUnsupportedError'
  }
}

export function isBeadsTaskSourceUnsupportedError(
  error: unknown
): error is BeadsTaskSourceUnsupportedError {
  return error instanceof BeadsTaskSourceUnsupportedError
}

const BD_UNAVAILABLE_STATUS: BeadsWorkspaceStatus = {
  bdInstalled: false,
  bdVersion: null,
  versionSupported: false,
  initialized: false
}

export type BeadsListIssuesArgs = {
  repoId: string
  /** Legacy route: hosts predating beads-query-filter.v1 strip the two params below. */
  preset: BeadsIssuePreset
  limit?: number
  /** 'all' includes closed issues; 'ready' = bd ready. */
  statusScope?: 'open' | 'all' | 'ready'
  /** '@me' resolves to the repo host's actor. */
  assignee?: string
}

type BeadsPreloadNamespace = {
  getStatus: (args: { repoId: string }) => Promise<BeadsStatusResult>
  listIssues: (args: BeadsListIssuesArgs) => Promise<BeadsListIssuesResult>
  getIssue: (args: { repoId: string; id: string }) => Promise<BeadsIssueResult>
  // Optional: absent in the browser build's preload replacement.
  updateIssue?: (args: {
    repoId: string
    id: string
    status: BeadsIssueStatus
  }) => Promise<BeadsUpdateIssueResult>
  getIssueDetails?: (args: { repoId: string; id: string }) => Promise<BeadsIssueDetailsResult>
  addComment?: (args: {
    repoId: string
    id: string
    text: string
  }) => Promise<BeadsIssueDetailsResult>
}

// Why: like Jira, the browser build's preload replacement omits beads; local
// dispatch degrades to "bd unavailable" instead of crashing on the missing namespace.
function getBeadsPreloadNamespace(): BeadsPreloadNamespace | null {
  const beads = (window.api as unknown as { beads?: BeadsPreloadNamespace }).beads
  return typeof beads?.listIssues === 'function' ? beads : null
}

function isTaskSourceRuntimeSettings(
  settings: RuntimeBeadsSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function getBeadsRuntimeTarget(
  settings: RuntimeBeadsSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

async function assertBeadsRuntimeCapability(environmentId: string): Promise<void> {
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    BEADS_TASK_SOURCE_RUNTIME_CAPABILITY,
    30_000
  )
  if (!supported) {
    throw new BeadsTaskSourceUnsupportedError()
  }
}

function normalizeBeadsStatusResult(value: unknown): BeadsStatusResult {
  const status = (value as Partial<BeadsStatusResult> | null | undefined)?.status
  return status && typeof status === 'object' ? { status } : { status: BD_UNAVAILABLE_STATUS }
}

function normalizeBeadsListIssuesResult(value: unknown): BeadsListIssuesResult {
  const result = value as Partial<BeadsListIssuesResult> | null | undefined
  return {
    issues: Array.isArray(result?.issues) ? result.issues : [],
    ...normalizeBeadsStatusResult(result)
  }
}

export async function beadsGetStatus(
  settings: RuntimeBeadsSettings,
  args: { repoId: string }
): Promise<BeadsStatusResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    return normalizeBeadsStatusResult(
      await callRuntimeRpc<unknown>(target, 'beads.getStatus', args, { timeoutMs: 30_000 })
    )
  }
  const beads = getBeadsPreloadNamespace()
  return beads
    ? normalizeBeadsStatusResult(await beads.getStatus(args))
    : { status: BD_UNAVAILABLE_STATUS }
}

const QUERY_FILTER_UNSUPPORTED_MESSAGE =
  'This remote runtime must be updated to search closed Beads issues.'

export async function beadsListIssues(
  settings: RuntimeBeadsSettings,
  args: BeadsListIssuesArgs
): Promise<BeadsListIssuesResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    // Why: an old host strips statusScope and would answer an "include closed"
    // query with open issues only — which the user reads as "no closed issues".
    // 'ready' and assignee degrade safely via the legacy preset, 'all' cannot.
    if (args.statusScope === 'all') {
      const supported = await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        BEADS_QUERY_FILTER_RUNTIME_CAPABILITY,
        30_000
      )
      if (!supported) {
        throw new BeadsTaskSourceUnsupportedError(QUERY_FILTER_UNSUPPORTED_MESSAGE)
      }
    }
    return normalizeBeadsListIssuesResult(
      await callRuntimeRpc<unknown>(target, 'beads.listIssues', args, { timeoutMs: 30_000 })
    )
  }
  const beads = getBeadsPreloadNamespace()
  return beads
    ? normalizeBeadsListIssuesResult(await beads.listIssues(args))
    : { issues: [], status: BD_UNAVAILABLE_STATUS }
}

export async function beadsGetIssue(
  settings: RuntimeBeadsSettings,
  args: { repoId: string; id: string }
): Promise<BeadsIssueResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    const result = await callRuntimeRpc<unknown>(target, 'beads.getIssue', args, {
      timeoutMs: 30_000
    })
    const issue = (result as Partial<BeadsIssueResult> | null | undefined)?.issue
    return { issue: issue && typeof issue === 'object' ? issue : null }
  }
  const beads = getBeadsPreloadNamespace()
  return beads ? beads.getIssue(args) : { issue: null }
}

const DETAILS_UNSUPPORTED_MESSAGE =
  'This remote runtime must be updated to read Beads issue relationships and comments.'
const COMMENT_UNSUPPORTED_MESSAGE =
  'This remote runtime must be updated to comment on Beads issues.'

function normalizeBeadsIssueDetailsResult(value: unknown): BeadsIssueDetailsResult {
  const details = (value as Partial<BeadsIssueDetailsResult> | null | undefined)?.details
  if (
    !details ||
    typeof details !== 'object' ||
    !details.issue ||
    typeof details.issue !== 'object'
  ) {
    return { details: null }
  }
  // Wire defensiveness: hosts are versioned independently, so absent arrays become empty.
  return {
    details: {
      issue: details.issue,
      parent: typeof details.parent === 'string' ? details.parent : null,
      dependencies: Array.isArray(details.dependencies) ? details.dependencies : [],
      dependents: Array.isArray(details.dependents) ? details.dependents : [],
      comments: Array.isArray(details.comments) ? details.comments : []
    }
  }
}

export async function beadsGetIssueDetails(
  settings: RuntimeBeadsSettings,
  args: { repoId: string; id: string }
): Promise<BeadsIssueDetailsResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    try {
      return normalizeBeadsIssueDetailsResult(
        await callRuntimeRpc<unknown>(target, 'beads.getIssueDetails', args, {
          timeoutMs: 30_000
        })
      )
    } catch (error) {
      // Why: read-only-era hosts advertise the beads capability yet lack this
      // method; the typed error lets the dialog degrade to plain-issue rendering.
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new BeadsTaskSourceUnsupportedError(DETAILS_UNSUPPORTED_MESSAGE)
      }
      throw error
    }
  }
  const beads = getBeadsPreloadNamespace()
  return typeof beads?.getIssueDetails === 'function'
    ? normalizeBeadsIssueDetailsResult(await beads.getIssueDetails(args))
    : { details: null }
}

export async function beadsAddComment(
  settings: RuntimeBeadsSettings,
  args: { repoId: string; id: string; text: string }
): Promise<BeadsIssueDetailsResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    try {
      return normalizeBeadsIssueDetailsResult(
        await callRuntimeRpc<unknown>(target, 'beads.addComment', args, { timeoutMs: 30_000 })
      )
    } catch (error) {
      // Why: a comment posted to a read-only-era host would vanish silently; the
      // typed error surfaces "host does not support this" instead.
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new BeadsTaskSourceUnsupportedError(COMMENT_UNSUPPORTED_MESSAGE)
      }
      throw error
    }
  }
  const beads = getBeadsPreloadNamespace()
  if (typeof beads?.addComment !== 'function') {
    // Mutations never degrade to a silent no-op like the read paths do.
    throw new BeadsTaskSourceUnsupportedError(COMMENT_UNSUPPORTED_MESSAGE)
  }
  return normalizeBeadsIssueDetailsResult(await beads.addComment(args))
}

const UPDATE_UNSUPPORTED_MESSAGE = 'This remote runtime must be updated to change Beads issues.'

function normalizeBeadsUpdateIssueResult(value: unknown): BeadsUpdateIssueResult {
  const issue = (value as Partial<BeadsUpdateIssueResult> | null | undefined)?.issue
  return {
    issue: issue && typeof issue === 'object' ? issue : null,
    ...normalizeBeadsStatusResult(value)
  }
}

export async function beadsUpdateIssue(
  settings: RuntimeBeadsSettings,
  args: { repoId: string; id: string; status: BeadsIssueStatus }
): Promise<BeadsUpdateIssueResult> {
  const target = getBeadsRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await assertBeadsRuntimeCapability(target.environmentId)
    try {
      return normalizeBeadsUpdateIssueResult(
        await callRuntimeRpc<unknown>(target, 'beads.updateIssue', args, { timeoutMs: 30_000 })
      )
    } catch (error) {
      // Why: read-only-beads-era hosts advertise the capability yet lack this
      // method; a status change must say "update the host", never fail silently.
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new BeadsTaskSourceUnsupportedError(UPDATE_UNSUPPORTED_MESSAGE)
      }
      throw error
    }
  }
  const beads = getBeadsPreloadNamespace()
  if (typeof beads?.updateIssue !== 'function') {
    // Mutations never degrade to a silent no-op like the read paths do.
    throw new BeadsTaskSourceUnsupportedError(UPDATE_UNSUPPORTED_MESSAGE)
  }
  return normalizeBeadsUpdateIssueResult(await beads.updateIssue(args))
}
