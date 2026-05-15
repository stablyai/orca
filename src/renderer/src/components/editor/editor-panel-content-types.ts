import type { GitDiffResult } from '../../../../shared/types'

export type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  loadError?: string
}

export type DiffContent = GitDiffResult
