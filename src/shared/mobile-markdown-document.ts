export const MOBILE_MARKDOWN_EDIT_MAX_BYTES = 256 * 1024

export type RuntimeMarkdownReadOnlyReason =
  | 'unsupported_preview'
  | 'unsupported_tab'
  | 'unsupported_untitled'
  | 'file_too_large'

export type RuntimeMobileMarkdownRequest =
  | {
      id: string
      operation: 'read'
      worktreeId: string
      tabId: string
    }
  | {
      id: string
      operation: 'save'
      worktreeId: string
      tabId: string
      baseVersion: string
      content: string
    }

export type RuntimeMobileMarkdownResponse =
  | {
      id: string
      ok: true
      result: RuntimeMarkdownReadTabResult | RuntimeMarkdownSaveTabResult
    }
  | {
      id: string
      ok: false
      error: string
    }

export type RuntimeMarkdownReadTabResult = {
  tabId: string
  filePath: string
  relativePath: string
  content: string
  isDirty: boolean
  version: string
  source: 'draft' | 'file'
  editable: boolean
  readOnlyReason?: RuntimeMarkdownReadOnlyReason
}

export type RuntimeMarkdownSaveTabResult = {
  tabId: string
  version: string
  isDirty: false
  content: string
}

export function hashMarkdownContent(content: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < content.length; i += 1) {
    hash ^= BigInt(content.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `content:${utf8ByteLength(content)}:${hash.toString(16).padStart(16, '0')}`
}

export function utf8ByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength
}
