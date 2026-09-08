import type { GitDiffResult } from '../git-diff-compare-types'
import type { GitStatusEntry, GitStatusResult } from '../git-status-types'
import { sha256 } from '../sha256'
import { buildMobileWebSourceControlDiffPage } from './source-control-diff-page'
import {
  MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusEntrySchema,
  MobileWebSourceControlStatusResultSchema,
  type MobileWebSourceControlDiffPayload,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusEntry,
  type MobileWebSourceControlStatusResult
} from './source-control-operation-contract'
import { MobileWebBrokerError } from './bridge-operation-error'

export function projectMobileWebSourceControlStatus(
  result: GitStatusResult,
  workspaceId: string,
  limit: number
): MobileWebSourceControlStatusResult {
  const entries = result.entries.slice(0, limit).flatMap((candidate) => {
    const entry = projectStatusEntry(candidate)
    return entry ? [entry] : []
  })
  const reportedTotal = result.statusLength
  const totalCount = Math.max(entries.length, reportedTotal ?? result.entries.length)
  const branch = result.branch?.slice(0, 240)
  const head =
    typeof result.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.head)
      ? result.head
      : undefined

  return MobileWebSourceControlStatusResultSchema.parse({
    workspaceId,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    conflictOperation: result.conflictOperation,
    entries,
    totalCount,
    truncated:
      result.didHitLimit === true ||
      result.entries.length > limit ||
      entries.length < Math.min(result.entries.length, limit) ||
      totalCount > entries.length
  })
}

export function projectMobileWebSourceControlDiff(
  result: GitDiffResult,
  payload: MobileWebSourceControlDiffPayload
): MobileWebSourceControlDiffResult {
  const identity = {
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    area: payload.area
  }
  if (result.kind === 'binary') {
    return MobileWebSourceControlDiffResultSchema.parse({ ...identity, kind: 'binary' })
  }
  if (result.largeDiffRenderLimit?.limited) {
    return {
      ...identity,
      kind: 'too-large',
      reason: 'host-limit',
      characterCount: result.largeDiffRenderLimit.characterCount
    }
  }

  const characterCount = result.originalContent.length + result.modifiedContent.length
  const revision =
    characterCount > MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS
      ? '0'.repeat(64)
      : diffRevision(result.originalContent, result.modifiedContent)
  if (payload.expectedRevision && revision !== payload.expectedRevision) {
    throw new MobileWebBrokerError('conflict')
  }
  return MobileWebSourceControlDiffResultSchema.parse(
    buildMobileWebSourceControlDiffPage({
      ...identity,
      revision,
      originalContent: result.originalContent,
      modifiedContent: result.modifiedContent,
      offset: payload.offset,
      limit: payload.limit
    })
  )
}

function projectStatusEntry(candidate: GitStatusEntry): MobileWebSourceControlStatusEntry | null {
  const parsed = MobileWebSourceControlStatusEntrySchema.safeParse({
    relativePath: candidate.path,
    ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
    status: candidate.status,
    area: candidate.area,
    ...(candidate.conflictStatus === undefined ? {} : { conflictStatus: candidate.conflictStatus }),
    ...(candidate.added === undefined ? {} : { added: candidate.added }),
    ...(candidate.removed === undefined ? {} : { removed: candidate.removed })
  })
  return parsed.success ? parsed.data : null
}

function diffRevision(originalContent: string, modifiedContent: string): string {
  return Array.from(
    sha256(new TextEncoder().encode(`${originalContent}\0${modifiedContent}`)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}
