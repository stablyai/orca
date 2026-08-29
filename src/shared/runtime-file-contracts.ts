import type { RasterImageDimensions } from './raster-image-dimensions'

export type RuntimeFileListEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type RuntimeFileListResult = {
  worktree: string
  rootPath: string
  files: RuntimeFileListEntry[]
  totalCount: number
  truncated: boolean
  quickOpenSearchVersion?: number
}

export type RuntimeFileOpenResult = {
  worktree: string
  relativePath: string
  kind: 'markdown' | 'text' | 'binary' | 'image'
  opened: boolean
}

export type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
  /** Budget that produced `truncated`. Absent on hosts predating this field. */
  maxByteLength?: number
  /**
   * Size the host stat'd. `byteLength` only measures the capped prefix it read,
   * so it must never be shown as the file's size. Absent when unobserved.
   */
  totalByteLength?: number
}

export type RuntimeTerminalPathOpenTarget =
  | {
      kind: 'worktree-file'
      provider: 'local' | 'ssh'
      relativePath: string
      absolutePath: string
    }
  | {
      kind: 'absolute-file'
      provider: 'local' | 'ssh'
      absolutePath: string
      grantId: string
      readOnly?: true
    }
  | { kind: 'unsupported'; reason: string }

export type RuntimeNativeChatFileContext = {
  tabId: string
  sessionId: string
}

export type RuntimeTerminalPathResolution = {
  worktree: string
  relativePath: string | null
  absolutePath: string | null
  exists: boolean
  isDirectory: boolean
  openTarget?: RuntimeTerminalPathOpenTarget
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
