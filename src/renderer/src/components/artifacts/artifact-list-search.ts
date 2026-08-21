import type { ArtifactListItem } from '../../../../shared/artifacts'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { artifactName, artifactTypeLabel } from './artifact-display-labels'

/** Pasted queries above this are clamped so filtering never runs on unbounded input. */
export const ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function artifactSearchHaystack(item: ArtifactListItem): string {
  return [
    artifactName(item),
    item.artifact.originalFileName,
    item.artifact.slug,
    artifactTypeLabel(item)
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
}

/**
 * Caps the controlled input value so a multi-MB paste cannot pin renderer memory.
 * Keeping maxBytes+1 code units is enough for the over-limit check while
 * discarding the rest of the paste.
 */
export function clampArtifactListSearchQuery(
  rawQuery: string,
  maxBytes = ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES
): string {
  return rawQuery.length <= maxBytes + 1 ? rawQuery : rawQuery.slice(0, maxBytes + 1)
}

/** Active lowercase query, or null when the list must stay unfiltered. */
export function activeArtifactListSearchQuery(
  rawQuery: string,
  maxBytes = ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES
): string | null {
  // Why: length pre-check short-circuits multi-MB pastes before the UTF-8 scan.
  if (isClipboardTextByteLengthOverLimit(rawQuery, maxBytes)) {
    return null
  }
  return rawQuery.trim().toLowerCase() || null
}

export function artifactMatchesSearchQuery(item: ArtifactListItem, query: string): boolean {
  const activeQuery = activeArtifactListSearchQuery(query)
  return activeQuery === null || artifactSearchHaystack(item).includes(activeQuery)
}

export function filterArtifactsBySearchQuery(
  artifacts: readonly ArtifactListItem[],
  query: string
): readonly ArtifactListItem[] {
  // Why: normalize once per filter, not once per artifact.
  const activeQuery = activeArtifactListSearchQuery(query)
  if (activeQuery === null) {
    return artifacts
  }
  return artifacts.filter((item) => artifactSearchHaystack(item).includes(activeQuery))
}
