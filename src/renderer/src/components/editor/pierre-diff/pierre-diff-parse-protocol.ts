import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInput } from './pierre-diff-metadata'
import type { PierreLineChanges } from './pierre-diff-line-changes'

export type PierreLineChangesInput = {
  oldLines: readonly string[]
  newLines: readonly string[]
  ignoreWhitespace: boolean
}
export type PierreDiffParseRequest =
  | { id: number; identity: string; input: PierreDiffInput }
  | { id: number; lines: PierreLineChangesInput }
export type PierreDiffParseResponse =
  | { id: number; diff: FileDiffMetadata }
  | { id: number; lineChanges: PierreLineChanges }
  | { id: number; error: string }

export type PierreDiffParseWorker = {
  postMessage: (request: PierreDiffParseRequest) => void
  terminate: () => void
  onmessage: ((event: MessageEvent<PierreDiffParseResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}
