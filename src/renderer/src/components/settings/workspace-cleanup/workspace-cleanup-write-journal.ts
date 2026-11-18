import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'

export const cleanupPolicyOwnerKey = (owner: RuntimeClientTarget) =>
  owner.kind === 'environment' ? `environment:${owner.environmentId}` : 'local'
const prefix = (owner: RuntimeClientTarget) =>
  `orca:cleanup-write:${encodeURIComponent(cleanupPolicyOwnerKey(owner))}:${clientId()}:`

function clientId(): string {
  const storage = window.sessionStorage
  const key = 'orca:cleanup-write-client'
  const existing = storage.getItem(key)
  if (existing) {
    return existing
  }
  const id = createNonSecureContextUuid()
  storage.setItem(key, id)
  return id
}

export function recordCleanupWrite(owner: RuntimeClientTarget, id: string, expiresAt: number) {
  window.localStorage.setItem(`${prefix(owner)}${id}`, JSON.stringify({ expiresAt }))
}
export function forgetCleanupWrite(owner: RuntimeClientTarget, id: string) {
  try {
    window.localStorage.removeItem(`${prefix(owner)}${id}`)
  } catch {
    // A retained receipt can be fenced again; losing an unresolved one would be unsafe.
  }
}
export function journaledCleanupWrites(
  owner: RuntimeClientTarget
): { id: string; expiresAt: number }[] {
  const storage = window.localStorage
  const start = prefix(owner)
  const result: { id: string; expiresAt: number }[] = []
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(start)) {
      continue
    }
    const value = storage.getItem(key)
    if (value === null) {
      continue
    }
    const parsed: unknown = JSON.parse(value)
    const id = key.slice(start.length)
    if (
      !/^[0-9a-f-]{36}$/i.test(id) ||
      typeof parsed !== 'object' ||
      parsed === null ||
      !('expiresAt' in parsed) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      throw new Error('workspace_cleanup_receipt_unavailable')
    }
    result.push({ id, expiresAt: parsed.expiresAt })
  }
  return result
}
