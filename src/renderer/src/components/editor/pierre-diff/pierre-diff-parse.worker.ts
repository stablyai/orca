import { buildPierreFileDiff } from './pierre-diff-metadata'
import type { PierreDiffParseRequest, PierreDiffParseResponse } from './pierre-diff-parse-protocol'

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PierreDiffParseRequest>) => void
  postMessage: (response: PierreDiffParseResponse) => void
}

scope.onmessage = ({ data: { id, identity, input } }) => {
  try {
    scope.postMessage({ id, diff: buildPierreFileDiff(input, identity) })
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
