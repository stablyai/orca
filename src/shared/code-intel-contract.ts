export const CODE_INTEL_MAX_LOCATIONS = 1000
export const CODE_INTEL_MAX_PREVIEW_LEN = 240

export type CodeIntelMethod = 'definition' | 'references'

export type CodeIntelPosition = { line: number; character: number }

export type CodeIntelRange = { start: CodeIntelPosition; end: CodeIntelPosition }

export type CodeIntelLocation = {
  /** Absolute path of the target file. The renderer opens this directly — it must
   *  not reconstruct paths from the worktree root, because the language service's
   *  project root (nearest tsconfig) is not always the worktree root (monorepos). */
  absolutePath: string
  /** Path relative to the language service's project root. For display only. */
  relativePath: string
  range: CodeIntelRange
  preview?: string
}

export type CodeIntelUnsupportedReason = 'remote-runtime' | 'no-tsconfig' | 'not-ts'

export type CodeIntelResult =
  | {
      status: 'ok'
      /** The buffer version this result was computed against, echoed from the
       *  request. The consumer discards the result when the editor has since
       *  advanced past it — its ranges point at now-shifted offsets (stale). */
      bufferVersion: number
      locations: CodeIntelLocation[]
      truncated: boolean
    }
  | { status: 'unsupported'; reason: CodeIntelUnsupportedReason }
  | { status: 'error'; code: string; message: string }

export type CodeIntelRequest = {
  filePath: string
  relativePath: string
  position: CodeIntelPosition
  bufferVersion: number
  bufferText?: string
}

export function isOkResult(
  result: CodeIntelResult
): result is Extract<CodeIntelResult, { status: 'ok' }> {
  return result.status === 'ok'
}

export function isUnsupportedResult(
  result: CodeIntelResult
): result is Extract<CodeIntelResult, { status: 'unsupported' }> {
  return result.status === 'unsupported'
}
