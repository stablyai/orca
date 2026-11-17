import { searchPierreDiff, type DiffSearchRequest } from './pierre-diff-search'

const scope = globalThis
scope.onmessage = ({ data }: MessageEvent<DiffSearchRequest>) => {
  try {
    scope.postMessage(searchPierreDiff(data))
  } catch {
    scope.postMessage({ matches: [], truncated: false, errorCode: 'search-failed' })
  }
}
