import { buildPierreFileDiff } from './pierre-diff-metadata'
import { computePierreLineChanges } from './pierre-diff-line-changes'
import type { PierreDiffParseRequest } from './pierre-diff-parse-protocol'

const scope = globalThis

scope.onmessage = ({ data }: MessageEvent<PierreDiffParseRequest>) => {
  try {
    if ('lines' in data) {
      const { oldLines, newLines, ignoreWhitespace } = data.lines
      scope.postMessage({
        id: data.id,
        lineChanges: computePierreLineChanges(oldLines, newLines, ignoreWhitespace)
      })
      return
    }
    scope.postMessage({ id: data.id, diff: buildPierreFileDiff(data.input, data.identity) })
  } catch (error) {
    scope.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
