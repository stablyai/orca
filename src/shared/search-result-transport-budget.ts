import type { SearchFileResult, SearchResult } from './code-search-types'
import { remoteRpcResultExceedsContentBudget } from './remote-rpc-content-budget'

/**
 * `result` cut to whole files that fit one remote reply, marked truncated: a search past the reply
 * cap otherwise fails outright. `maxBytes === undefined` means uncapped (local callers).
 */
export function limitSearchResultToContentBudget(
  result: SearchResult,
  maxBytes: number | undefined
): SearchResult {
  if (maxBytes === undefined || !remoteRpcResultExceedsContentBudget(result, maxBytes)) {
    return result
  }
  const files: SearchFileResult[] = []
  // `{"files":[],"totalMatches":N,"truncated":true}` with room for any count.
  let bytes = 64
  for (const file of result.files) {
    const fileBytes = Buffer.byteLength(JSON.stringify(file), 'utf8') + 1
    if (bytes + fileBytes > maxBytes) {
      break
    }
    files.push(file)
    bytes += fileBytes
  }
  const totalMatches = files.reduce(
    (sum, file) => sum + (file.matchCount ?? file.matches.length),
    0
  )
  return { files, totalMatches, truncated: true }
}
