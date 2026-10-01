import {
  imagePasteWritesFollowedByText,
  separateImagePasteFromFollowingText
} from './image-paste-following-text'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { filesystemPathToFileUri } from './file-uri-path'

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
  // Why: Grok CLI pastes images via bracketed path / image chips (see xAI
  // terminal docs + pager paste.rs). Keep it on the same attachment path as
  // Claude/Codex rather than treating path paste as unsupported text.
  'grok'
])

export function getAgentImageHandling(agent: string | null | undefined): AgentImageHandling {
  return agent && IMAGE_ATTACHMENT_AGENTS.has(agent) ? 'attachment' : 'unsupported'
}

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
