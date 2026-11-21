import {
  imagePasteWritesFollowedByText,
  separateImagePasteFromFollowingText
} from '../../../terminal/input/image-paste-following-text'
import { isWindowsAbsolutePathLike } from '../../../file-access/cross-platform-path'
import { filesystemPathToFileUri } from '../../../file-links/file-uri-path'

// Whether raw-path paste is verified to create an attachment; others use file references.
export type AgentImageHandling = 'attachment' | 'unsupported'

const IMAGE_ATTACHMENT_AGENTS: ReadonlySet<string> = new Set<string>([
  'claude',
  'openclaude',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'droid',
  // Grok supports bracketed path/image chips (xAI terminal docs and pager paste.rs).
  'grok'
])

export function getAgentImageHandling(agent: string | null | undefined): AgentImageHandling {
  return agent && IMAGE_ATTACHMENT_AGENTS.has(agent) ? 'attachment' : 'unsupported'
}

/** Quoted file references can resemble image markers when paths contain whitespace. */
export const NATIVE_CHAT_QUOTED_FILE_REFERENCE = /@"(?:\\"|[^"])*"|@'[^']*'/

export function formatNativeChatFileReference(filePath: string): string {
  if (!/[\s@]/.test(filePath)) {
    return `@${filePath}`
  }
  if (!filePath.includes('"')) {
    return `@"${filePath}"`
  }
  if (!filePath.includes("'")) {
    return `@'${filePath}'`
  }
  const escaped = filePath.replace(/"/g, '\\"')
  return `@"${escaped}"`
}

export function formatAgentImagePath(agent: string | null | undefined, filePath: string): string {
  if (
    agent === 'omp' &&
    /[\s@]/.test(filePath) &&
    filePath.includes('"') &&
    filePath.includes("'") &&
    (filePath.startsWith('/') || isWindowsAbsolutePathLike(filePath))
  ) {
    // OMP's mention lexer cannot escape quotes, but its path resolver decodes file URLs.
    return `@"${filesystemPathToFileUri(filePath)}"`
  }
  return getAgentImageHandling(agent) === 'attachment'
    ? filePath
    : formatNativeChatFileReference(filePath)
}

export function agentImagePasteWrites(
  agent: string | null | undefined,
  framedPastes: readonly string[],
  followedByText: boolean
): string[] {
  if (getAgentImageHandling(agent) === 'attachment') {
    return imagePasteWritesFollowedByText(framedPastes, followedByText)
  }
  // TUI paste frames disappear in the editor; file mentions still need word boundaries.
  return framedPastes.map((paste, index) =>
    separateImagePasteFromFollowingText(paste, index < framedPastes.length - 1 || followedByText)
  )
}

/** Keep a resized attachment associated with the file the user selected. */
export function agentImageSourceContext(
  original: readonly string[],
  delivered: readonly string[]
): string {
  if (!original.some((path, index) => delivered[index] && delivered[index] !== path)) {
    return ''
  }
  const sources = original.map(
    (path, index) =>
      `Image source file: ${JSON.stringify(path)}; attached viewing copy: ${JSON.stringify(delivered[index] ?? path)}`
  )
  return sources.length ? `[${sources.join('\n')}]` : ''
}

export function agentImageDeliveryText(
  text: string,
  original: readonly string[],
  delivered: readonly string[]
): string {
  const context = agentImageSourceContext(original, delivered)
  return context ? `${text}${text.trim() ? '\n\n' : ''}${context}` : text
}

export type AgentImageSourceContextRange = {
  start: number
  end: number
  original: string[]
  delivered: string[]
}

export function* agentImageSourceContexts(text: string): Generator<AgentImageSourceContextRange> {
  const pattern =
    /Image source file: ("(?:[^"\\]|\\.)*"); attached viewing copy: ("(?:[^"\\]|\\.)*")/g
  let start = -1
  let cursor = 0
  let original: string[] = []
  let delivered: string[] = []
  for (const match of text.matchAll(pattern)) {
    if (text[match.index - 1] === '[') {
      start = match.index - 1
      original = []
      delivered = []
    } else if (start === -1 || text.slice(cursor, match.index).trim()) {
      start = -1
      continue
    }
    try {
      original.push(JSON.parse(match[1]))
      delivered.push(JSON.parse(match[2]))
    } catch {
      start = -1
      continue
    }
    cursor = match.index + match[0].length
    if (text[cursor] === ']') {
      yield { start, end: cursor + 1, original, delivered }
      start = -1
    }
  }
}

export function readAgentImageSourceContext(text: string): {
  text: string
  original: string[]
  delivered: string[]
} {
  if (text.endsWith(']')) {
    for (const context of agentImageSourceContexts(text)) {
      if (context.end === text.length) {
        return {
          text: text.slice(0, context.start).trimEnd(),
          original: context.original,
          delivered: context.delivered
        }
      }
    }
  }
  return { text, original: [], delivered: [] }
}
