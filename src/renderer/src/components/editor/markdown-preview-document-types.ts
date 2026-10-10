import type { Root } from 'hast'
import type { MarkdownTocItem } from './markdown-table-of-contents'

export const LARGE_MARKDOWN_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
export const MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES = 400_000
export const MARKDOWN_PREVIEW_BLOCK_MAX_NODES = 4096
export const MARKDOWN_PREVIEW_VIEWPORT_MAX_NODES = 16_384
export const MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS = 40
export const MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS = 15_000
export const MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES = 10_000
export const MARKDOWN_PREVIEW_SEARCH_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const MARKDOWN_PREVIEW_SEARCH_TEXT_MAX_NODES = 400_000

export type MarkdownPreviewBlock = {
  index: number
  estimate: number
  anchors: string[]
  sourceLine: number | null
  sourceColumn?: number
  sourceEndLine: number | null
}
export type MarkdownPreviewDocument = {
  blocks: MarkdownPreviewBlock[]
  toc: MarkdownTocItem[]
}
export type MarkdownPreviewRenderedBlock = { index: number; tree: Root; oversized: boolean }
export type MarkdownPreviewDocumentMatch = { block: number; occurrence: number }
export type MarkdownPreviewWorkerRequest =
  | { id: number; type: 'load'; content: string }
  | { id: number; type: 'blocks'; indices: number[] }
  | { id: number; type: 'search'; query: string }
  | { id: number; type: 'cancel-search' }
export type MarkdownPreviewWorkerResult =
  | { id: number; type: 'loaded'; document: MarkdownPreviewDocument }
  | { id: number; type: 'blocks'; blocks: MarkdownPreviewRenderedBlock[] }
  | { id: number; type: 'search'; matches: MarkdownPreviewDocumentMatch[]; truncated: boolean }
  | { id: number; type: 'error'; message: string }
