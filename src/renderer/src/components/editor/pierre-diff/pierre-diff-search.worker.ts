import {
  searchPierreDiff,
  type DiffSearchRequest,
  type DiffSearchResult
} from './pierre-diff-search'

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DiffSearchRequest>) => void
  postMessage: (response: DiffSearchResult) => void
}
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage(searchPierreDiff(data))
  } catch {
    scope.postMessage({ matches: [], truncated: false, errorCode: 'search-failed' })
  }
}
