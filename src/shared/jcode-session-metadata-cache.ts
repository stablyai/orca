import { basename } from 'node:path'

export type JcodeSessionMetadata = {
  id: string
  parentId: string | null
  shortName?: string
  title?: string
  closed: boolean
}

export const metadataCacheEntries = Symbol('JcodeSessionMetadataCache')

export type JcodeSessionMetadataCache = {
  readonly [metadataCacheEntries]: Map<
    string,
    { metadata: JcodeSessionMetadata | null; expiresAt: number }
  >
}

export function createJcodeSessionMetadataCache(
  source?: JcodeSessionMetadataCache
): JcodeSessionMetadataCache {
  return {
    [metadataCacheEntries]: new Map(source?.[metadataCacheEntries])
  }
}

export function forgetCachedJcodeSessions(
  cache: JcodeSessionMetadataCache,
  sessionIds: ReadonlySet<string>
): void {
  for (const path of cache[metadataCacheEntries].keys()) {
    if (sessionIds.has(basename(path, '.json'))) {
      cache[metadataCacheEntries].delete(path)
    }
  }
}
