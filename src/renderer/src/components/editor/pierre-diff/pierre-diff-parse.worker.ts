import { buildPierreFileDiff } from './pierre-diff-metadata'
import type { PierreDiffParseRequest } from './pierre-diff-parse-protocol'

const scope = globalThis

scope.onmessage = ({ data: { id, identity, input } }: MessageEvent<PierreDiffParseRequest>) => {
  try {
    scope.postMessage({ id, diff: buildPierreFileDiff(input, identity) })
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
