import { filePreviewExtension } from './file-preview/file-preview-kind'

// The Anthropic API, Claude Code, Codex, Pi and ACP agents take only these inline; other images go as file references.
const AGENT_INLINE_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/** The MIME type an agent receives this file as, or null when it must go as a file reference. */
export function agentInlineImageMimeType(path: string): string | null {
  return AGENT_INLINE_IMAGE_MIME_TYPES[filePreviewExtension(path)] ?? null
}

export function isAgentInlineImagePath(path: string): boolean {
  return agentInlineImageMimeType(path) !== null
}

export function isAgentInlineImageMimeType(mimeType: string): boolean {
  return Object.values(AGENT_INLINE_IMAGE_MIME_TYPES).includes(mimeType)
}
