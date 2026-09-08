import {
  MobileWebFileDirectoryEntrySchema,
  MobileWebFileDirectoryResultSchema,
  type MobileWebFileDirectoryEntry,
  type MobileWebFileDirectoryResult
} from './bridge-operation-contract'
import { MobileWebBrokerError } from './bridge-operation-error'
import {
  compareMobileWebDirectoryEntries,
  mobileWebDirectoryRevision
} from './file-directory-presentation'

export function sanitizeDirectoryResult(
  result: unknown,
  relativePath: string,
  limit: number
): Omit<MobileWebFileDirectoryResult, 'workspaceId'> {
  if (!Array.isArray(result)) {
    throw new MobileWebBrokerError('host_error')
  }
  const names = new Set<string>()
  const entries = result.slice(0, limit).flatMap((value): MobileWebFileDirectoryEntry[] => {
    if (!isRecord(value) || typeof value.name !== 'string' || names.has(value.name)) {
      return []
    }
    const parsed = MobileWebFileDirectoryEntrySchema.safeParse({
      name: value.name,
      isDirectory: value.isDirectory === true,
      isSymlink: value.isSymlink === true
    })
    if (!parsed.success) {
      return []
    }
    names.add(parsed.data.name)
    return [parsed.data]
  })
  entries.sort(compareMobileWebDirectoryEntries)
  const truncated = result.length > entries.length
  return MobileWebFileDirectoryResultSchema.omit({ workspaceId: true }).parse({
    relativePath,
    revision: mobileWebDirectoryRevision(entries, truncated),
    entries,
    truncated
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
