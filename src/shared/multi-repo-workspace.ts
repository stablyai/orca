import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { getWorktreePathBasenameFromId, splitWorktreeIdForFilesystem } from './worktree/id'

export const MULTI_REPO_WORKSPACE_MIN_MEMBERS = 2
export const MULTI_REPO_WORKSPACE_MAX_MEMBERS = 12
export const MULTI_REPO_WORKSPACE_CREATE_CONCURRENCY = 3
export const MULTI_REPO_MEMBER_FAILURE_MESSAGE_MAX_LENGTH = 400
export const MULTI_REPO_SYSTEM_GROUP_NAME = 'Workspaces'

export const MULTI_REPO_MEMBER_STATES = [
  'queued',
  'creating',
  'ready',
  'failed',
  'interrupted'
] as const
export type MultiRepoMemberState = (typeof MULTI_REPO_MEMBER_STATES)[number]

export const MULTI_REPO_MEMBER_FAILURE_CODES = [
  'path_occupied',
  'branch_conflict',
  'git_failed',
  'setup_failed',
  'repo_unavailable',
  'host_unavailable',
  'unknown'
] as const
export type MultiRepoMemberFailureCode = (typeof MULTI_REPO_MEMBER_FAILURE_CODES)[number]

export type MultiRepoMember = {
  /** Stable across retries; doubles as the create progress `creationId`. */
  memberId: string
  repoId: string
  /** Leaf directory under the workspace root. Unique case-insensitively within the workspace. */
  dirName: string
  /** The user's explicit branch, or the predicted default until the worktree reports its real branch. */
  branchName: string
  /** True when the user typed the branch; false lets the create pipeline apply the branch prefix. */
  branchExplicit?: boolean
  baseRef?: string
  state: MultiRepoMemberState
  attempts: number
  failure?: { code: MultiRepoMemberFailureCode; message: string; at: number }
  /** Set once ready; join key to the worktree catalog and WorkspaceLineage. */
  worktreeId?: string
  worktreeInstanceId?: string
}

export type MultiRepoWorkspace = {
  version: 1
  executionHostId: ExecutionHostId
  /** True when Orca created the root directory; gates root removal on delete. */
  rootOwnedByOrca: boolean
  /** Order is the strip and sidebar order. */
  members: MultiRepoMember[]
  /** Members taken out with detachMember; attachMember restores one while its worktree still exists. */
  detachedMembers?: MultiRepoMember[]
  /** Set when the user asked for an agent; the client starts it once every member settles. */
  pendingAgentStart?: boolean
}

/** Members that no longer change state without user action. */
export function isMultiRepoMemberSettled(member: Pick<MultiRepoMember, 'state'>): boolean {
  return member.state === 'ready' || member.state === 'failed' || member.state === 'interrupted'
}

export function isMultiRepoWorkspaceSettled(
  workspace: Pick<MultiRepoWorkspace, 'members'>
): boolean {
  return workspace.members.every(isMultiRepoMemberSettled)
}

export const MULTI_REPO_WORKSPACE_ERROR_CODES = [
  'multi_repo_capability_unsupported',
  'multi_repo_invalid_members',
  'multi_repo_repo_not_found',
  'multi_repo_repo_not_git',
  'multi_repo_repo_direct_ssh',
  'multi_repo_repo_wsl',
  'multi_repo_mixed_hosts',
  'multi_repo_workspace_not_found',
  'multi_repo_member_not_found',
  'multi_repo_member_not_retryable',
  'multi_repo_member_not_removable',
  'multi_repo_member_not_detachable',
  'multi_repo_member_not_attachable',
  'multi_repo_member_locked',
  'multi_repo_root_unavailable',
  'multi_repo_delete_force_not_named',
  'multi_repo_create_in_progress',
  'multi_repo_force_not_allowed',
  'multi_repo_has_members'
] as const
export type MultiRepoWorkspaceErrorCode = (typeof MULTI_REPO_WORKSPACE_ERROR_CODES)[number]

export class MultiRepoWorkspaceError extends Error {
  readonly code: MultiRepoWorkspaceErrorCode
  readonly data?: Record<string, unknown>

  constructor(code: MultiRepoWorkspaceErrorCode, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'MultiRepoWorkspaceError'
    this.code = code
    this.data = data
  }
}

/** Per-member preflight for group delete. `null` means the check could not run, never "clean". */
export type MultiRepoDeleteMemberInspection = {
  memberId: string
  repoId: string
  state: MultiRepoMemberState
  worktreeId: string | null
  /** False when the worktree directory or repo is gone; removal then only forgets metadata. */
  worktreeExists: boolean
  dirtyCount: number | null
  unpublishedCommitCount: number | null
  /** Branch is deleted only when merged; false means the branch survives removal. */
  willKeepBranch: boolean | null
}

export type MultiRepoDeleteInspection = {
  folderWorkspaceId: string
  members: MultiRepoDeleteMemberInspection[]
  rootPath: string
  rootOwnedByOrca: boolean
}

export type MultiRepoDeleteMemberOutcome =
  | { memberId: string; status: 'removed'; preservedBranch?: string }
  | { memberId: string; status: 'dropped' }
  | { memberId: string; status: 'failed'; code: string; message: string }

export type MultiRepoDeleteResult = {
  folderWorkspaceId: string
  members: MultiRepoDeleteMemberOutcome[]
  /** True once the folder workspace record is gone (every member removed). */
  workspaceRemoved: boolean
  /** Why the root directory was left on disk; absent when it was removed or the workspace remains. */
  rootKept?: { path: string; reason: 'not_empty' | 'not_owned' | 'remove_failed' }
  remainingMemberCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const SALVAGED_MEMBER_ID_PREFIX = 'salvaged:'

function isMemberState(value: unknown): value is MultiRepoMemberState {
  return MULTI_REPO_MEMBER_STATES.some((state) => state === value)
}

function isFailureCode(value: unknown): value is MultiRepoMemberFailureCode {
  return MULTI_REPO_MEMBER_FAILURE_CODES.some((code) => code === value)
}

/** A member that owns a worktree is never dropped: missing fields are derived from the worktree id and the member is marked interrupted so Retry can adopt it and delete can remove it. */
function normalizeMember(raw: unknown): MultiRepoMember | null {
  if (!isRecord(raw)) {
    return null
  }
  const worktreeId = nonEmptyString(raw.worktreeId)
  const parsedWorktree = worktreeId ? splitWorktreeIdForFilesystem(worktreeId) : null
  const dirName =
    nonEmptyString(raw.dirName) ?? (worktreeId ? getWorktreePathBasenameFromId(worktreeId) : null)
  const memberId =
    nonEmptyString(raw.memberId) ??
    (worktreeId ? `${SALVAGED_MEMBER_ID_PREFIX}${worktreeId}` : null)
  const repoId = nonEmptyString(raw.repoId) ?? nonEmptyString(parsedWorktree?.repoId) ?? worktreeId
  const branchName = nonEmptyString(raw.branchName) ?? dirName
  if (!memberId || !repoId || !dirName || !branchName) {
    return null
  }
  const validState = isMemberState(raw.state) ? raw.state : null
  if (!validState && !worktreeId) {
    return null
  }
  const derived =
    !nonEmptyString(raw.memberId) ||
    !nonEmptyString(raw.repoId) ||
    !nonEmptyString(raw.dirName) ||
    !nonEmptyString(raw.branchName)
  // Derived identity or a ready member without a worktree cannot be trusted as-is; interrupted lets Retry adopt it.
  const state =
    !validState || derived || (validState === 'ready' && !worktreeId) ? 'interrupted' : validState
  const baseRef = nonEmptyString(raw.baseRef)
  const branchExplicit = raw.branchExplicit === true
  const worktreeInstanceId = nonEmptyString(raw.worktreeInstanceId)
  const failureRaw = raw.failure
  const failure =
    isRecord(failureRaw) &&
    isFailureCode(failureRaw.code) &&
    typeof failureRaw.at === 'number' &&
    Number.isFinite(failureRaw.at)
      ? {
          code: failureRaw.code,
          message:
            typeof failureRaw.message === 'string'
              ? failureRaw.message.slice(0, MULTI_REPO_MEMBER_FAILURE_MESSAGE_MAX_LENGTH)
              : '',
          at: failureRaw.at
        }
      : undefined
  return {
    memberId,
    repoId,
    dirName,
    branchName,
    ...(branchExplicit ? { branchExplicit: true } : {}),
    ...(baseRef ? { baseRef } : {}),
    state,
    attempts:
      typeof raw.attempts === 'number' && Number.isInteger(raw.attempts) && raw.attempts >= 0
        ? raw.attempts
        : 0,
    ...(failure ? { failure } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(worktreeInstanceId ? { worktreeInstanceId } : {})
  }
}

function hasWorktreeOwner(rawMembers: unknown): boolean {
  return (
    Array.isArray(rawMembers) &&
    rawMembers.some((member) => isRecord(member) && nonEmptyString(member.worktreeId) !== null)
  )
}

/** Garbage returns `undefined` so the workspace survives as a plain folder workspace, unless it still lists worktrees: those are salvaged so delete cannot orphan them. */
export function normalizeMultiRepoWorkspace(value: unknown): MultiRepoWorkspace | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const ownsWorktrees = hasWorktreeOwner(value.members) || hasWorktreeOwner(value.detachedMembers)
  const hostId = parseExecutionHostId(
    typeof value.executionHostId === 'string' ? value.executionHostId : null
  )?.id
  const validOuter = value.version === 1 && hostId !== undefined && Array.isArray(value.members)
  if (!validOuter && !ownsWorktrees) {
    return undefined
  }
  const executionHostId = hostId ?? LOCAL_EXECUTION_HOST_ID
  const seenMembers = new Map<string, string | undefined>()
  const normalizeMembers = (rawMembers: unknown): MultiRepoMember[] => {
    const normalized: MultiRepoMember[] = []
    for (const rawMember of Array.isArray(rawMembers) ? rawMembers : []) {
      let member = normalizeMember(rawMember)
      if (!member) {
        continue
      }
      if (seenMembers.has(member.memberId)) {
        if (!member.worktreeId || seenMembers.get(member.memberId) === member.worktreeId) {
          continue
        }
        member = { ...member, memberId: `${SALVAGED_MEMBER_ID_PREFIX}${member.worktreeId}` }
        if (seenMembers.has(member.memberId)) {
          continue
        }
      }
      seenMembers.set(member.memberId, member.worktreeId)
      normalized.push(member)
    }
    return normalized
  }
  const members = normalizeMembers(value.members)
  const detachedMembers = normalizeMembers(value.detachedMembers)
  return {
    version: 1,
    executionHostId,
    rootOwnedByOrca: value.rootOwnedByOrca === true,
    members,
    ...(detachedMembers.length > 0 ? { detachedMembers } : {}),
    ...(value.pendingAgentStart === true ? { pendingAgentStart: true } : {})
  }
}
