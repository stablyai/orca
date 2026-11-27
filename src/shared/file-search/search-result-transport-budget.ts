import type { SearchFileResult, SearchResult } from './code-search-types'
import { remoteRpcResultExceedsContentBudget } from '../remote-runtime/rpc/remote-rpc-content-budget'

/**
 * Keep files and a prefix of the final file's matches that fit one remote reply, marked truncated.
 * A search past the reply cap otherwise fails outright. `maxBytes === undefined` means uncapped.
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
      const partial = limitFileMatchesToContentBudget(file, maxBytes - bytes)
      if (partial) {
        files.push(partial)
      }
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

function limitFileMatchesToContentBudget(
  file: SearchFileResult,
  maxBytes: number
): SearchFileResult | null {
  const partial: SearchFileResult = { ...file, matches: [], matchCount: file.matches.length }
  // The final count can only have fewer digits; reserve its widest possible spelling.
  let bytes = Buffer.byteLength(JSON.stringify(partial), 'utf8') + 1
  for (const match of file.matches) {
    const matchBytes =
      Buffer.byteLength(JSON.stringify(match), 'utf8') + (partial.matches.length > 0 ? 1 : 0)
    if (bytes + matchBytes > maxBytes) {
      break
    }
    partial.matches.push(match)
    bytes += matchBytes
  }
  partial.matchCount = partial.matches.length
  return partial.matches.length > 0 ? partial : null
}
