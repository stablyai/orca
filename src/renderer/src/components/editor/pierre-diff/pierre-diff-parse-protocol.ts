import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInput } from './pierre-diff-metadata'

export type PierreDiffParseRequest = { id: number; identity: string; input: PierreDiffInput }
export type PierreDiffParseResponse =
  | { id: number; diff: FileDiffMetadata }
  | { id: number; error: string }

export type PierreDiffParseWorker = {
  postMessage: (request: PierreDiffParseRequest) => void
  terminate: () => void
  onmessage: ((event: MessageEvent<PierreDiffParseResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}
