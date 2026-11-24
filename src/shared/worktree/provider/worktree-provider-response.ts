import { isAbsolute } from 'node:path'
import {
  MAX_WORKTREE_PROVIDER_HANDLE_JSON_LENGTH,
  type WorktreeProviderClaimResponse
} from './worktree-provider-types'

export type WorktreeProviderClaimParseResult =
  | { ok: true; value: WorktreeProviderClaimResponse }
  | {
      ok: false
      reason: string
      /** Whatever parsed, so a failed claim can still be released instead of orphaned. */
      leaseId?: string
      handle?: Record<string, unknown>
    }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above proves a plain object.
  return value as Record<string, unknown>
}

function safePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return null
  }
  // oxlint-disable-next-line no-control-regex -- paths must not carry control bytes
  if (!isAbsolute(value) || /[\u0000-\u001f]/.test(value)) {
    return null
  }
  return value
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function optionalHandle(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  try {
    return JSON.stringify(record).length <= MAX_WORKTREE_PROVIDER_HANDLE_JSON_LENGTH
      ? record
      : undefined
  } catch {
    return undefined
  }
}

/** Claim stdout must be exactly one JSON object; diagnostics belong on stderr. */
export function parseWorktreeProviderClaimResponse(
  stdout: string
): WorktreeProviderClaimParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { ok: false, reason: 'The claim command did not print JSON.' }
  }
  const record = asRecord(parsed)
  if (!record) {
    return { ok: false, reason: 'The claim response must be a JSON object.' }
  }
  const leaseId =
    optionalString(record.lease_id, 512) ?? optionalString(record.leaseId, 512) ?? undefined
  const handle = optionalHandle(record.handle)
  const profile = optionalString(record.profile, 256)
  const path = safePath(record.path)
  if (!path) {
    return {
      ok: false,
      reason: 'The claim response must include an absolute "path".',
      ...(leaseId ? { leaseId } : {}),
      ...(handle ? { handle } : {})
    }
  }
  return {
    ok: true,
    value: {
      path,
      ...(leaseId ? { leaseId } : {}),
      ...(profile ? { profile } : {}),
      ...(handle ? { handle } : {})
    }
  }
}
