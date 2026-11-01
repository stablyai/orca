import type { DirEntry } from '../../../../../shared/filesystem-entry-types'

export type TerminalFilePeekContent =
  | {
      kind: 'text'
      path: string
      language: string
      firstLineNumber: number
      targetLine: number | null
      lines: string[]
      truncatedLines: boolean
    }
  | { kind: 'markdown'; path: string; source: string }
  | { kind: 'image'; path: string; sizeBytes: number }
  | { kind: 'directory'; path: string; entries: DirEntry[]; hasMore: boolean }
  | {
      kind: 'notice'
      path: string
      reason: 'binary' | 'too-large' | 'line-out-of-range' | 'unreadable' | 'unsupported'
    }
