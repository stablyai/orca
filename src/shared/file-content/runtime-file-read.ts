import type { RasterImageDimensions } from '../file-preview/raster-image-dimensions'

export type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

export type RuntimeFilePreviewResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  imageDimensions?: RasterImageDimensions
}

export type RuntimeFileReadChunkResult = {
  contentBase64: string
  bytesRead: number
  eof: boolean
}
